import { apiSocket } from './apiSocket';

/**
 * Mirror of the JobRecordView type from the daemon's job store.
 * Source of truth: packages/happy-cli/src/daemon/jobs/jobView.ts
 */
export interface JobRecordView {
    id: string;
    triggerType: 'manual' | 'cron' | 'event';
    tier: 'trusted' | 'supervised';
    preset: string;
    directory: string;
    prompt: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'needs-attention';
    attempts: number;
    maxAttempts: number;
    sessionId?: string;
    /** PID of the Claude process inside the session. Source of truth: packages/happy-cli/src/daemon/jobs/jobView.ts */
    sessionPid?: number;
    scheduledAt?: number;
    claimedAt?: number;
    timeoutAt?: number;
    finishedAt?: number;
    exitReason?: string;
    costUsd?: number;
    maxBudgetUsd?: number;
    maxTurns?: number;
    gitHeadBefore?: string;
    gitHeadAfter?: string;
    dispositionTopic?: string;
    gateAction?: string;
    gateBucket?: string;
    gateReason?: string;
    gateResolved?: boolean;
    createdAt: number;
}

export async function machineSubmitJob(machineId: string, params: {
    directory: string;
    prompt: string;
    tier?: 'trusted' | 'supervised';
    preset?: string;
    maxBudgetUsd?: number;
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string[];
    dispositionTopic?: string;
}): Promise<{ jobId: string }> {
    const { dispositionTopic, ...rest } = params;
    const payload = { ...rest, ...(dispositionTopic ? { dispositionTopic } : {}) };
    const result = await apiSocket.machineRPC<{ jobId: string }, typeof payload>(
        machineId,
        'submit-job',
        payload
    );
    return result;
}

export async function machineStopJob(machineId: string, sessionId: string): Promise<{ stopped: boolean }> {
    const result = await apiSocket.machineRPC<{ stopped: boolean }, { sessionId: string }>(
        machineId,
        'stop-job',
        { sessionId }
    );
    return result;
}

/** Cancels a pending (non-running) job. Mirrors the stop-job RPC pattern. */
export async function machineCancelJob(machineId: string, jobId: string): Promise<{ cancelled: boolean }> {
    const result = await apiSocket.machineRPC<{ cancelled: boolean }, { jobId: string }>(
        machineId,
        'cancel-job',
        { jobId }
    );
    return result;
}

/** Resolves a gate-parked job (E05): 'approve' runs it, 'reject' drives it to dead. */
export async function machineResolveGate(machineId: string, jobId: string, decision: 'approve' | 'reject'): Promise<{ resolved: boolean }> {
    const result = await apiSocket.machineRPC<{ resolved: boolean }, { jobId: string; decision: 'approve' | 'reject' }>(
        machineId,
        'resolve-gate',
        { jobId, decision }
    );
    return result;
}

export async function machineListJobs(machineId: string, status?: JobRecordView['status']): Promise<JobRecordView[]> {
    try {
        const result = await apiSocket.machineRPC<{ jobs: JobRecordView[] }, { status?: JobRecordView['status'] }>(
            machineId,
            'list-jobs',
            status ? { status } : {}
        );
        return result.jobs;
    } catch {
        return [];
    }
}

export async function machineGetJob(machineId: string, id: string): Promise<JobRecordView | null> {
    try {
        const result = await apiSocket.machineRPC<{ job: JobRecordView | null }, { id: string }>(
            machineId,
            'get-job',
            { id }
        );
        return result.job;
    } catch {
        return null;
    }
}
