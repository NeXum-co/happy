import { apiSocket } from './apiSocket';

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
}): Promise<{ jobId: string }> {
    const result = await apiSocket.machineRPC<{ jobId: string }, typeof params>(
        machineId,
        'submit-job',
        params
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
