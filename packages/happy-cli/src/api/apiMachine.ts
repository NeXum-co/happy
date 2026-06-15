/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '../modules/common/registerCommonHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { detectCLIAvailability, CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport, type ResumeSupport } from '@/resume/localHappyAgentAuth';
import { shouldReconnect } from '@/utils/lidState';
import { getProjectPath } from '@/claude/utils/path';
import {
    forkSession as claudeForkSession,
    forkAndTruncateSession as claudeForkAndTruncateSession,
    listClaudeRewindPoints,
    ForkTruncateUuidNotFoundError,
    ForkSourceMissingError,
} from '@/claude/utils/claudeSessionFork';
import type { JobStatus } from '@/daemon/jobs/jobTypes';
import type { JobRecordView } from '@/daemon/jobs/jobView';
import type { SubmitCronParams } from '@/daemon/jobs/cronFeeder';
import type { CronScheduleView } from '@/daemon/jobs/cronTypes';
import { validateCronExpr } from '@/daemon/jobs/cronSchedule';
import type { SubmitEventSubscriptionParams } from '@/daemon/jobs/eventTrigger';
import type { EventSubscriptionView } from '@/daemon/jobs/eventTypes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    resumeSession?: (sessionId: string, options?: { model?: string; permissionMode?: string }) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => boolean;
    requestShutdown: () => void;
    /** Create a durable autonomous job from submit-job params; returns its id. */
    submitJob?: (params: SubmitJobParams) => string;
    /** Targeted kill of an autonomous job's session; returns whether one was found. */
    stopJob?: (sessionId: string) => boolean;
    /** List durable jobs, optionally filtered by status. Returns JobRecordView[] without triggerMetadata. */
    listJobs?: (filter?: { status?: JobStatus }) => JobRecordView[];
    /** Get a single durable job by id. Returns JobRecordView or null if not found. */
    getJob?: (id: string) => JobRecordView | null;
    /** Cancel a non-running (pending/retrying) job; returns whether it was cancelled. */
    cancelJob?: (jobId: string) => boolean;
    /** Create a durable cron schedule from submit-cron params; returns its id. */
    submitCron?: (params: SubmitCronParams) => string;
    /** List all cron schedules as CronScheduleView projections. */
    listCrons?: () => CronScheduleView[];
    /** Delete a cron schedule by id; returns whether one was removed. */
    deleteCron?: (id: string) => boolean;
    /** Create a durable event subscription from submit params; returns its id. */
    submitEventSubscription?: (params: SubmitEventSubscriptionParams) => string;
    /** List all event subscriptions as EventSubscriptionView projections. */
    listEventSubscriptions?: () => EventSubscriptionView[];
    /** Delete an event subscription by id; returns whether one was removed. */
    deleteEventSubscription?: (id: string) => boolean;
    /** Deliver an event: match subscriptions and create jobs; returns created job ids. */
    triggerEvent?: (params: { eventType: string; matchKey?: string; idempotencyKey?: string; payload?: unknown }) => { created: string[] };
}

/** Params accepted by the submit-job RPC / HTTP endpoint (autonomous jobs, E04). */
export interface SubmitJobParams {
    directory: string;
    prompt: string;
    tier?: 'trusted' | 'supervised';
    preset?: string;
    maxBudgetUsd?: number;
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string[];
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private lastKnownCLIAvailability: CLIAvailability | null = null;
    private lastKnownResumeSupport: ResumeSupport | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private resumeSessionHandler: ((sessionId: string, options?: { model?: string; permissionMode?: string }) => Promise<SpawnSessionResult>) | null = null;
    private reconnectInterval: NodeJS.Timeout | null = null;

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        registerCommonHandlers(this.rpcHandlerManager, process.cwd());
    }

    setRPCHandlers({
        spawnSession,
        resumeSession,
        stopSession,
        requestShutdown,
        submitJob,
        stopJob,
        listJobs,
        getJob,
        cancelJob,
        submitCron,
        listCrons,
        deleteCron,
        submitEventSubscription,
        listEventSubscriptions,
        deleteEventSubscription,
        triggerEvent
    }: MachineRpcHandlers) {
        this.resumeSessionHandler = resumeSession ?? null;

        // Register submit-job handler (autonomous jobs, E04). Creates a durable
        // pending job; the daemon scheduler claims and runs it on its next tick.
        if (submitJob) {
            this.rpcHandlerManager.registerHandler('submit-job', async (params: any) => {
                const { directory, prompt, tier, preset, maxBudgetUsd, maxTurns, timeoutMs, allowedTools } = params || {};
                if (typeof directory !== 'string' || directory.length === 0) {
                    throw new Error('directory is required');
                }
                if (typeof prompt !== 'string' || prompt.length === 0) {
                    throw new Error('prompt is required');
                }
                const jobId = submitJob({ directory, prompt, tier, preset, maxBudgetUsd, maxTurns, timeoutMs, allowedTools });
                logger.debug(`[API MACHINE] Submitted job ${jobId}`);
                return { jobId };
            });
        }

        // Register stop-job handler (autonomous jobs, E04). Targeted kill of a
        // running job's session; returns whether a session was found.
        if (stopJob) {
            this.rpcHandlerManager.registerHandler('stop-job', async (params: any) => {
                const { sessionId } = params || {};
                if (typeof sessionId !== 'string' || sessionId.length === 0) {
                    throw new Error('sessionId is required');
                }
                const stopped = stopJob(sessionId);
                logger.debug(`[API MACHINE] Stop job ${sessionId}: ${stopped}`);
                return { stopped };
            });
        }

        // Register list-jobs handler (autonomous jobs, E04). Returns all jobs
        // (or filtered by status) as JobRecordView projections for the dashboard.
        if (listJobs) {
            this.rpcHandlerManager.registerHandler('list-jobs', async (params: any) => {
                const status = params?.status;
                return { jobs: listJobs(status ? { status } : undefined) };
            });
        }

        // Register get-job handler (autonomous jobs, E04). Fetches a single
        // job by id as a JobRecordView; returns null when not found.
        if (getJob) {
            this.rpcHandlerManager.registerHandler('get-job', async (params: any) => {
                const { id } = params || {};
                if (typeof id !== 'string' || id.length === 0) throw new Error('id is required');
                return { job: getJob(id) };
            });
        }

        // Register cancel-job handler (autonomous jobs, E04). Cancels a non-running
        // (pending/retrying) job to a terminal 'dead' state; a running job is refused
        // (use stop-job to kill a live session). Mirrors the HTTP /cancel-job endpoint.
        if (cancelJob) {
            this.rpcHandlerManager.registerHandler('cancel-job', async (params: any) => {
                const { jobId } = params || {};
                if (typeof jobId !== 'string' || jobId.length === 0) throw new Error('jobId is required');
                const cancelled = cancelJob(jobId);
                logger.debug(`[API MACHINE] Cancel job ${jobId}: ${cancelled}`);
                return { cancelled };
            });
        }

        // Register submit-cron handler (cron schedules, E04). Validates the cron
        // expression with the real validateCronExpr before creating a durable
        // enabled schedule; the cron feeder turns it into jobs on its ticks.
        if (submitCron) {
            this.rpcHandlerManager.registerHandler('submit-cron', async (params: any) => {
                const { cronExpr, directory, prompt, tier, preset, maxBudgetUsd, maxTurns, timeoutMs, allowedTools } = params || {};
                if (typeof directory !== 'string' || directory.length === 0) {
                    throw new Error('directory is required');
                }
                if (typeof prompt !== 'string' || prompt.length === 0) {
                    throw new Error('prompt is required');
                }
                if (typeof cronExpr !== 'string' || cronExpr.length === 0 || !validateCronExpr(cronExpr)) {
                    throw new Error('invalid cronExpr');
                }
                const cronId = submitCron({ cronExpr, directory, prompt, tier, preset, maxBudgetUsd, maxTurns, timeoutMs, allowedTools });
                logger.debug(`[API MACHINE] Submitted cron ${cronId}`);
                return { cronId };
            });
        }

        // Register list-crons handler (cron schedules, E04). Returns all
        // schedules as CronScheduleView projections for the dashboard.
        if (listCrons) {
            this.rpcHandlerManager.registerHandler('list-crons', async () => {
                return { crons: listCrons() };
            });
        }

        // Register delete-cron handler (cron schedules, E04). Removes a schedule
        // by id; returns whether a row was deleted.
        if (deleteCron) {
            this.rpcHandlerManager.registerHandler('delete-cron', async (params: any) => {
                const { id } = params || {};
                if (typeof id !== 'string' || id.length === 0) throw new Error('id is required');
                const deleted = deleteCron(id);
                logger.debug(`[API MACHINE] Delete cron ${id}: ${deleted}`);
                return { deleted };
            });
        }

        // Register submit-event-subscription handler (event subscriptions, E04).
        // Validates eventType/directory/prompt before creating a durable enabled
        // subscription; trigger-event turns matching events into jobs.
        if (submitEventSubscription) {
            this.rpcHandlerManager.registerHandler('submit-event-subscription', async (params: any) => {
                const { eventType, matchKey, directory, prompt, tier, preset, maxBudgetUsd, maxTurns, timeoutMs, allowedTools } = params || {};
                if (typeof eventType !== 'string' || eventType.length === 0) {
                    throw new Error('eventType is required');
                }
                if (typeof directory !== 'string' || directory.length === 0) {
                    throw new Error('directory is required');
                }
                if (typeof prompt !== 'string' || prompt.length === 0) {
                    throw new Error('prompt is required');
                }
                const subscriptionId = submitEventSubscription({ eventType, matchKey, directory, prompt, tier, preset, maxBudgetUsd, maxTurns, timeoutMs, allowedTools });
                logger.debug(`[API MACHINE] Submitted event subscription ${subscriptionId}`);
                return { subscriptionId };
            });
        }

        // Register list-event-subscriptions handler (event subscriptions, E04).
        // Returns all subscriptions as EventSubscriptionView projections.
        if (listEventSubscriptions) {
            this.rpcHandlerManager.registerHandler('list-event-subscriptions', async () => {
                return { subscriptions: listEventSubscriptions() };
            });
        }

        // Register delete-event-subscription handler (event subscriptions, E04).
        // Removes a subscription by id; returns whether a row was deleted.
        if (deleteEventSubscription) {
            this.rpcHandlerManager.registerHandler('delete-event-subscription', async (params: any) => {
                const { id } = params || {};
                if (typeof id !== 'string' || id.length === 0) throw new Error('id is required');
                const deleted = deleteEventSubscription(id);
                logger.debug(`[API MACHINE] Delete event subscription ${id}: ${deleted}`);
                return { deleted };
            });
        }

        // Register trigger-event handler (event subscriptions, E04). Matches the
        // incoming event against subscriptions and creates a job per match (deduped
        // by idempotencyKey); returns the created/targeted job ids.
        if (triggerEvent) {
            this.rpcHandlerManager.registerHandler('trigger-event', async (params: any) => {
                const { eventType, matchKey, idempotencyKey, payload } = params || {};
                if (typeof eventType !== 'string' || eventType.length === 0) {
                    throw new Error('eventType is required');
                }
                const { created } = triggerEvent({ eventType, matchKey, idempotencyKey, payload });
                logger.debug(`[API MACHINE] Triggered event ${eventType}: created ${created.length} job(s)`);
                return { created };
            });
        }

        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, profile, sessionName, sessionId, machineId, approvedNewDirectoryCreation, agent, environmentVariables, token, resumeClaudeSessionId, parentSessionId, forkedFromMessageId } = params || {};
            logger.debug(`[API MACHINE] Spawning session with params: ${JSON.stringify(params)}`);

            if (!directory && !profile) {
                throw new Error('Directory is required');
            }

            const result = await spawnSession({ directory, profile, sessionName, sessionId, machineId, approvedNewDirectoryCreation, agent, environmentVariables, token, resumeClaudeSessionId, parentSessionId, forkedFromMessageId });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    return { type: 'success', sessionId: result.sessionId };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        });

        this.syncResumeSessionRpcRegistration();

        // Register stop session handler
        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const success = stopSession(sessionId);
            if (!success) {
                throw new Error('Session not found or failed to stop');
            }

            logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
            return { message: 'Session stopped' };
        });

        // Register Claude session fork handlers (used by app-side fork /
        // duplicate flows). These take the source session's working
        // directory and underlying Claude UUID, copy the on-disk JSONL
        // — optionally truncated at a chosen message — and return the new
        // Claude UUID. The caller then spawns a fresh Happy session with
        // `resumeClaudeSessionId` set so `claude --resume <newUuid>`
        // continues the conversation.
        this.rpcHandlerManager.registerHandler('claude-fork-session', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkSession(getProjectPath(directory), claudeSessionId);
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        // List user-text rewind points directly from the on-disk JSONL.
        // The server-side session log misses claudeUuid for messages typed
        // live in the app (legacy `sentFrom: 'web'` path); disk is the
        // source of truth and carries the right uuids for every message.
        this.rpcHandlerManager.registerHandler('claude-list-rewind-points', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const points = await listClaudeRewindPoints(getProjectPath(directory), claudeSessionId);
                return { type: 'success', points };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('claude-duplicate-session', async (params: any) => {
            const { directory, claudeSessionId, cutAfterUuid } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            if (typeof cutAfterUuid !== 'string' || !UUID_RE.test(cutAfterUuid)) {
                throw new Error('cutAfterUuid must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkAndTruncateSession(
                    getProjectPath(directory),
                    claudeSessionId,
                    cutAfterUuid,
                );
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                if (error instanceof ForkTruncateUuidNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source session — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });
    }

    private syncResumeSessionRpcRegistration(): void {
        const method = 'resume-happy-session';

        if (this.resumeSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const { sessionId, model, permissionMode } = params || {};

                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('Session ID is required');
                    }

                    const handler = this.resumeSessionHandler;
                    if (!handler) {
                        throw new Error('Resume session handler not available');
                    }

                    const result = await handler(sessionId, { model, permissionMode });
                    switch (result.type) {
                        case 'success':
                            return { type: 'success', sessionId: result.sessionId };
                        case 'requestToApproveDirectoryCreation':
                            return result;
                        case 'error':
                            throw new Error(result.errorMessage);
                    }
                });
            }
            return;
        }

        if (this.rpcHandlerManager.hasHandler(method)) {
            this.rpcHandlerManager.unregisterHandler(method);
        }
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    connect() {
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        this.socket = io(serverUrl, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id,
                happyClient: `cli-daemon/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
        });

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');

            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }

            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));

            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.syncResumeSessionRpcRegistration();
            this.startKeepAlive();
        });

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API MACHINE] Disconnected from server — reason: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
            this.startSmartReconnect();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        // Handle update events from server
        this.socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
            this.startSmartReconnect();
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) {
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);

            // Re-detect CLI availability and push metadata update if changed
            const newAvailability = detectCLIAvailability();
            const prev = this.lastKnownCLIAvailability;
            const newResumeSupport = detectResumeSupport();
            const prevResume = this.lastKnownResumeSupport;
            const cliAvailabilityChanged = !prev || prev.claude !== newAvailability.claude || prev.codex !== newAvailability.codex || prev.gemini !== newAvailability.gemini || prev.openclaw !== newAvailability.openclaw;
            const resumeSupportChanged = !prevResume
                || prevResume.rpcAvailable !== newResumeSupport.rpcAvailable
                || prevResume.happyAgentAuthenticated !== newResumeSupport.happyAgentAuthenticated;

            if (cliAvailabilityChanged || resumeSupportChanged) {
                this.lastKnownCLIAvailability = newAvailability;
                this.lastKnownResumeSupport = newResumeSupport;
                this.updateMachineMetadata((metadata) => ({
                    ...(metadata || {} as any),
                    cliAvailability: newAvailability,
                    resumeSupport: { ...newResumeSupport, rpcAvailable: !!this.resumeSessionHandler },
                })).catch((err) => {
                    logger.debug('[API MACHINE] Failed to update machine capabilities:', err);
                });
            }
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private startSmartReconnect() {
        if (this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API MACHINE] Still not ready to reconnect');
                return;
            }
            logger.debug('[API MACHINE] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API MACHINE] Network up + lid open — reconnecting in 1s');
            setTimeout(() => { if (!this.socket.connected) this.socket.connect() }, 1000);
        }
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        this.stopKeepAlive();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}
