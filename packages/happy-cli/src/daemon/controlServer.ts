/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';
import { TrackedSession, SessionEncryptionData } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import type { SubmitJobParams } from '@/api/apiMachine';
import type { JobStatus } from './jobs/jobTypes';
import { jobRecordViewSchema, type JobRecordView } from './jobs/jobView';

export function startDaemonControlServer({
  getChildren,
  stopSession,
  spawnSession,
  submitJob,
  stopJob,
  cancelJob,
  listJobs,
  getJob,
  patchJobCost,
  requestShutdown,
  onHappySessionWebhook
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  submitJob: (params: SubmitJobParams) => string;
  stopJob: (sessionId: string) => boolean;
  cancelJob: (jobId: string) => boolean;
  listJobs: (filter?: { status?: JobStatus }) => JobRecordView[];
  getJob: (id: string) => JobRecordView | null;
  patchJobCost: (sessionId: string, costUsd: number) => boolean;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata, encryption?: SessionEncryptionData) => void;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any(),
          encryption: z.object({
            encryptionKey: z.string(),
            encryptionVariant: z.enum(['legacy', 'dataKey']),
            seq: z.number(),
            metadataVersion: z.number(),
            agentStateVersion: z.number(),
          }).optional()
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata, encryption } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);

      let encryptionData: SessionEncryptionData | undefined;
      if (encryption) {
        encryptionData = {
          encryptionKey: decodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
        };
      }

      onHappySessionWebhook(sessionId, metadata, encryptionData);

      return { status: 'ok' as const };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { 
        children: children
          .filter(child => child.happySessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            happySessionId: child.happySessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = stopSession(sessionId);
      return { success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional(),
          agent: z.enum(['claude', 'codex', 'gemini', 'openclaw']).optional(),
          environmentVariables: z.record(z.string(), z.string()).optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, agent, environmentVariables } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}, agent=${agent || 'default'}`);
      const result = await spawnSession({ directory, sessionId, agent, environmentVariables });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Submit an autonomous job (E04). Used by the orchestrator for integration
    // testing without the relay. Creates a durable pending job and returns its id.
    typed.post('/submit-job', {
      schema: {
        body: z.object({
          directory: z.string(),
          prompt: z.string(),
          tier: z.enum(['trusted', 'supervised']).optional(),
          preset: z.string().optional(),
          maxBudgetUsd: z.number().optional(),
          maxTurns: z.number().optional(),
          timeoutMs: z.number().optional(),
          allowedTools: z.array(z.string()).optional(),
        }),
        response: {
          200: z.object({
            jobId: z.string()
          })
        }
      }
    }, async (request) => {
      const jobId = submitJob(request.body);
      logger.debug(`[CONTROL SERVER] Submitted job ${jobId}`);
      return { jobId };
    });

    // Targeted kill of an autonomous job's session (E04). SIGTERM + SIGKILL
    // escalation, then mark the job needs-attention. Returns whether a session
    // was found.
    typed.post('/stop-job', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            stopped: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;
      logger.debug(`[CONTROL SERVER] Stop job request: ${sessionId}`);
      const stopped = stopJob(sessionId);
      return { stopped };
    });

    // Cancel a non-running autonomous job (E04). For a pending/retrying job (no
    // live session) this drives it to a terminal 'dead' state. A running job is
    // refused (cancelled:false) — /stop-job kills live sessions.
    typed.post('/cancel-job', {
      schema: {
        body: z.object({
          jobId: z.string()
        }),
        response: {
          200: z.object({
            cancelled: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { jobId } = request.body;
      logger.debug(`[CONTROL SERVER] Cancel job request: ${jobId}`);
      const cancelled = cancelJob(jobId);
      return { cancelled };
    });

    // List autonomous jobs (E04). GET /jobs?status=<status> returns all jobs
    // (or filtered by status) as JobRecordView projections for the dashboard.
    typed.get('/jobs', {
      schema: {
        querystring: z.object({
          status: z.enum(['pending', 'running', 'succeeded', 'failed', 'dead', 'needs-attention']).optional()
        }),
        response: {
          200: z.object({
            jobs: z.array(jobRecordViewSchema)
          })
        }
      }
    }, async (request) => {
      const { status } = request.query as { status?: JobStatus };
      const filter = status ? { status } : undefined;
      logger.debug(`[CONTROL SERVER] List jobs request: status=${status ?? 'all'}`);
      return { jobs: listJobs(filter) };
    });

    // Get a single autonomous job by id (E04). Returns the JobRecordView or
    // null when no job with the given id exists.
    typed.get('/jobs/:id', {
      schema: {
        params: z.object({
          id: z.string()
        }),
        response: {
          200: z.object({
            job: jobRecordViewSchema.nullable()
          })
        }
      }
    }, async (request) => {
      const { id } = request.params as { id: string };
      logger.debug(`[CONTROL SERVER] Get job request: id=${id}`);
      return { job: getJob(id) };
    });

    // Record an autonomous job's final cost (E04). Reported by a cloud-preset
    // job session on clean exit, keyed by its sessionId. No-op (ok:false) for a
    // sessionId that maps to no job.
    typed.post('/job-cost', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          costUsd: z.number()
        }),
        response: {
          200: z.object({
            ok: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId, costUsd } = request.body;
      logger.debug(`[CONTROL SERVER] Job cost report: session=${sessionId} cost=${costUsd}`);
      return { ok: patchJobCost(sessionId, costUsd) };
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
