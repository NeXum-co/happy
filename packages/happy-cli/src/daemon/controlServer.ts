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
import { SessionEncryptionData } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import type { SubmitJobParams } from '@/api/apiMachine';
import type { JobStatus } from './jobs/jobTypes';
import { jobRecordViewSchema, type JobRecordView } from './jobs/jobView';
import type { SubmitCronParams } from './jobs/cronFeeder';
import type { CronScheduleView } from './jobs/cronTypes';
import type { SubmitEventSubscriptionParams } from './jobs/eventTrigger';
import type { EventSubscriptionView } from './jobs/eventTypes';

// Typed response schemas for the cron/event list endpoints (QUAL-3/COMP-4).
// Mirror CronScheduleView / EventSubscriptionView so the wire shape is locked
// rather than `z.array(z.any())`. Keep in lockstep with cronTypes / eventTypes.
const cronScheduleViewSchema = z.object({
  id: z.string(),
  cronExpr: z.string(),
  directory: z.string(),
  prompt: z.string(),
  tier: z.enum(['trusted', 'supervised']),
  preset: z.string(),
  maxBudgetUsd: z.number().optional(),
  maxTurns: z.number().optional(),
  timeoutMs: z.number().optional(),
  allowedTools: z.array(z.string()).optional(),
  enabled: z.boolean(),
  createdAt: z.number(),
});

const eventSubscriptionViewSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  matchKey: z.string().optional(),
  directory: z.string(),
  prompt: z.string(),
  tier: z.enum(['trusted', 'supervised']),
  preset: z.string(),
  maxBudgetUsd: z.number().optional(),
  maxTurns: z.number().optional(),
  timeoutMs: z.number().optional(),
  allowedTools: z.array(z.string()).optional(),
  enabled: z.boolean(),
  createdAt: z.number(),
});

export function startDaemonControlServer({
  listSessions,
  stopSession,
  spawnSession,
  submitJob,
  stopJob,
  cancelJob,
  resolveGate,
  accountSwitch,
  getUsage,
  listAccounts,
  addAccount,
  setDefaultAccount,
  removeAccount,
  getBurnPolicy,
  setBurnPolicy,
  listJobs,
  getJob,
  patchJobCost,
  submitCron,
  listCrons,
  deleteCron,
  submitEventSubscription,
  listEventSubscriptions,
  deleteEventSubscription,
  triggerEvent,
  requestShutdown,
  onHappySessionWebhook
}: {
  listSessions: () => { startedBy: string; happySessionId: string; pid: number; account?: string }[];
  stopSession: (sessionId: string) => boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  submitJob: (params: SubmitJobParams) => string;
  stopJob: (sessionId: string) => boolean;
  cancelJob: (jobId: string) => boolean;
  resolveGate: (jobId: string, decision: 'approve' | 'reject') => Promise<boolean>;
  accountSwitch: (sessionIds: string[], account: string) => Promise<{ ok: boolean; remapped?: string[]; skipped?: string[]; error?: string }>;
  getUsage: () => Record<string, { fiveHourUtil: number | null; sevenDayUtil: number | null; seenAt: number | null }>;
  listAccounts: () => Promise<{ name: string; isDefault: boolean; addedAt: number }[]>;
  addAccount: (name: string, token: string, isDefault?: boolean) => Promise<void>;
  setDefaultAccount: (name: string) => Promise<void>;
  removeAccount: (name: string) => Promise<void>;
  getBurnPolicy: () => Promise<{ enabled: boolean; order: string[]; thresholdPct: number }>;
  setBurnPolicy: (config: { enabled: boolean; order: string[]; thresholdPct: number }) => Promise<void>;
  listJobs: (filter?: { status?: JobStatus }) => JobRecordView[];
  getJob: (id: string) => JobRecordView | null;
  patchJobCost: (sessionId: string, costUsd: number) => boolean;
  submitCron: (params: SubmitCronParams) => string;
  listCrons: () => CronScheduleView[];
  deleteCron: (id: string) => boolean;
  submitEventSubscription: (params: SubmitEventSubscriptionParams) => string;
  listEventSubscriptions: () => EventSubscriptionView[];
  deleteEventSubscription: (id: string) => boolean;
  triggerEvent: (params: { eventType: string; matchKey?: string; idempotencyKey?: string; payload?: unknown }) => { created: string[] };
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata, encryption?: SessionEncryptionData) => void;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
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
              pid: z.number(),
              account: z.string().optional()
            }))
          })
        }
      }
    }, async () => {
      const children = listSessions();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { children };
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
          dispositionTopic: z.string().optional(),
          untrustedInput: z.boolean().optional(),
          account: z.string().optional(),
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

    // Live-switch (E10, AC-4): remap een gekozen set lopende cloud-sessies naar één
    // account in de authProxy — geen respawn. Fail-closed op het doel-account (AC-6).
    // Mirrors the account-switch RPC handler (BUG-UAT-1: beide surfaces).
    typed.post('/account-switch', {
      schema: {
        body: z.object({
          sessionIds: z.array(z.string()),
          account: z.string()
        }),
        response: {
          200: z.object({
            ok: z.boolean(),
            remapped: z.array(z.string()).optional(),
            skipped: z.array(z.string()).optional(),
            error: z.string().optional()
          })
        }
      }
    }, async (request) => {
      const { sessionIds, account } = request.body;
      logger.debug(`[CONTROL SERVER] Account switch: ${sessionIds.length} sessie(s) → ${account}`);
      return accountSwitch(sessionIds, account);
    });

    // Usage-read (E10, AC-5): per-account laatst-geziene 5h/7d-utilisatie die de
    // proxy uit de unified-* headers scrapte. Fail-soft (onbekend → null). Mirrors
    // the get-usage RPC handler (BUG-UAT-1: beide surfaces).
    typed.post('/usage', {
      schema: {
        response: {
          200: z.object({
            usage: z.record(z.string(), z.object({
              fiveHourUtil: z.number().nullable(),
              sevenDayUtil: z.number().nullable(),
              seenAt: z.number().nullable()
            }))
          })
        }
      }
    }, async () => {
      return { usage: getUsage() };
    });

    // Account-management (E10, S5, D-E10-17) over de versleutelde vault. Mirrors the
    // RPC handlers (BUG-UAT-1: beide surfaces). `/list-accounts` lekt geen token;
    // `/add-account` neemt een geheim token dat versleuteld de vault in gaat — niet gelogd.
    typed.post('/list-accounts', {
      schema: {
        response: {
          200: z.object({
            accounts: z.array(z.object({
              name: z.string(),
              isDefault: z.boolean(),
              addedAt: z.number()
            }))
          })
        }
      }
    }, async () => {
      return { accounts: await listAccounts() };
    });

    typed.post('/add-account', {
      schema: {
        body: z.object({
          name: z.string().min(1),
          token: z.string().min(1),
          isDefault: z.boolean().optional()
        }),
        response: { 200: z.object({ ok: z.boolean() }) }
      }
    }, async (request) => {
      const { name, token, isDefault } = request.body;
      logger.debug(`[CONTROL SERVER] Add account: ${name} (default=${isDefault ?? false})`); // geen token
      await addAccount(name, token, isDefault);
      return { ok: true };
    });

    typed.post('/set-default-account', {
      schema: {
        body: z.object({ name: z.string().min(1) }),
        response: { 200: z.object({ ok: z.boolean() }) }
      }
    }, async (request) => {
      await setDefaultAccount(request.body.name);
      return { ok: true };
    });

    typed.post('/remove-account', {
      schema: {
        body: z.object({ name: z.string().min(1) }),
        response: { 200: z.object({ ok: z.boolean() }) }
      }
    }, async (request) => {
      await removeAccount(request.body.name);
      return { ok: true };
    });

    // Burn-policy (E10, S6, AC-8): instelbare burn-volgorde + drempel. Mirrors the
    // get-burn-policy/set-burn-policy RPC handlers (BUG-UAT-1: beide surfaces).
    const burnPolicyBody = z.object({
      enabled: z.boolean(),
      order: z.array(z.string().min(1)),
      thresholdPct: z.number().min(0).max(1)
    });
    typed.post('/get-burn-policy', {
      schema: { response: { 200: z.object({ policy: burnPolicyBody }) } }
    }, async () => {
      return { policy: await getBurnPolicy() };
    });

    typed.post('/set-burn-policy', {
      schema: { body: burnPolicyBody, response: { 200: z.object({ ok: z.boolean() }) } }
    }, async (request) => {
      await setBurnPolicy(request.body);
      return { ok: true };
    });

    // Resolve a gate-parked autonomous job (E05, D-E05-4). A job parked in
    // 'needs-attention' by the pre-spawn confidence gate awaits Joshua: 'approve'
    // runs it (honouring a proceed-supervised tier downgrade), 'reject' drives it
    // to dead. Mirrors the resolve-gate RPC handler (BUG-UAT-1: both surfaces).
    typed.post('/resolve-gate', {
      schema: {
        body: z.object({
          jobId: z.string(),
          decision: z.enum(['approve', 'reject'])
        }),
        response: {
          200: z.object({
            resolved: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { jobId, decision } = request.body;
      logger.debug(`[CONTROL SERVER] Resolve gate request: ${jobId} decision=${decision}`);
      const resolved = await resolveGate(jobId, decision);
      return { resolved };
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

    // Submit a cron schedule (E04). Validates the cron expression daemon-side
    // (submitCron throws on an invalid expr) and creates a durable enabled
    // schedule; the cron feeder turns it into jobs on its ticks.
    typed.post('/submit-cron', {
      schema: {
        body: z.object({
          cronExpr: z.string(),
          directory: z.string(),
          prompt: z.string(),
          tier: z.enum(['trusted', 'supervised']).optional(),
          preset: z.string().optional(),
          maxBudgetUsd: z.number().optional(),
          maxTurns: z.number().optional(),
          timeoutMs: z.number().optional(),
          allowedTools: z.array(z.string()).optional(),
          dispositionTopic: z.string().optional(),
          untrustedInput: z.boolean().optional(),
          account: z.string().optional(),
        }),
        response: {
          200: z.object({
            cronId: z.string()
          }),
          400: z.object({
            error: z.string()
          })
        }
      }
    }, async (request, reply) => {
      try {
        const cronId = submitCron(request.body);
        logger.debug(`[CONTROL SERVER] Submitted cron ${cronId}`);
        return { cronId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`[CONTROL SERVER] Submit cron rejected: ${message}`);
        return reply.code(400).send({ error: message });
      }
    });

    // List cron schedules (E04). Returns all schedules as CronScheduleView
    // projections for the dashboard.
    typed.get('/crons', {
      schema: {
        response: {
          200: z.object({
            crons: z.array(cronScheduleViewSchema)
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] List crons request');
      return { crons: listCrons() };
    });

    // Delete a cron schedule by id (E04). Returns whether a row was removed.
    typed.post('/delete-cron', {
      schema: {
        body: z.object({
          id: z.string()
        }),
        response: {
          200: z.object({
            deleted: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { id } = request.body;
      logger.debug(`[CONTROL SERVER] Delete cron request: ${id}`);
      return { deleted: deleteCron(id) };
    });

    // Submit an event subscription (E04). Validates eventType/directory/prompt
    // daemon-side and creates a durable enabled subscription; trigger-event turns
    // matching events into jobs.
    typed.post('/submit-event-subscription', {
      schema: {
        body: z.object({
          eventType: z.string(),
          matchKey: z.string().optional(),
          directory: z.string(),
          prompt: z.string(),
          tier: z.enum(['trusted', 'supervised']).optional(),
          preset: z.string().optional(),
          maxBudgetUsd: z.number().optional(),
          maxTurns: z.number().optional(),
          timeoutMs: z.number().optional(),
          allowedTools: z.array(z.string()).optional(),
          dispositionTopic: z.string().optional(),
          untrustedInput: z.boolean().optional(),
          account: z.string().optional(),
        }),
        response: {
          200: z.object({
            subscriptionId: z.string()
          }),
          400: z.object({
            error: z.string()
          })
        }
      }
    }, async (request, reply) => {
      try {
        const subscriptionId = submitEventSubscription(request.body);
        logger.debug(`[CONTROL SERVER] Submitted event subscription ${subscriptionId}`);
        return { subscriptionId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`[CONTROL SERVER] Submit event subscription rejected: ${message}`);
        return reply.code(400).send({ error: message });
      }
    });

    // List event subscriptions (E04). Returns all subscriptions as
    // EventSubscriptionView projections for the dashboard.
    typed.get('/event-subscriptions', {
      schema: {
        response: {
          200: z.object({
            subscriptions: z.array(eventSubscriptionViewSchema)
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] List event subscriptions request');
      return { subscriptions: listEventSubscriptions() };
    });

    // Delete an event subscription by id (E04). Returns whether a row was removed.
    typed.post('/delete-event-subscription', {
      schema: {
        body: z.object({
          id: z.string()
        }),
        response: {
          200: z.object({
            deleted: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { id } = request.body;
      logger.debug(`[CONTROL SERVER] Delete event subscription request: ${id}`);
      return { deleted: deleteEventSubscription(id) };
    });

    // Deliver an event (E04). Matches the event against subscriptions and creates
    // a job per match (deduped by idempotencyKey); returns the created/targeted
    // job ids.
    typed.post('/trigger-event', {
      schema: {
        body: z.object({
          eventType: z.string(),
          matchKey: z.string().optional(),
          idempotencyKey: z.string().optional(),
          payload: z.any().optional(),
        }),
        response: {
          200: z.object({
            created: z.array(z.string())
          }),
          400: z.object({
            error: z.string()
          })
        }
      }
    }, async (request, reply) => {
      try {
        const { created } = triggerEvent(request.body);
        logger.debug(`[CONTROL SERVER] Trigger event ${request.body.eventType}: created ${created.length} job(s)`);
        return { created };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`[CONTROL SERVER] Trigger event rejected: ${message}`);
        return reply.code(400).send({ error: message });
      }
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
        reject(err);
        return;
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
