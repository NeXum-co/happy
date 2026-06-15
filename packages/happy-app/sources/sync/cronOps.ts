import { apiSocket } from './apiSocket';

/**
 * Mirror of the CronScheduleView type from the daemon's cron store.
 * Source of truth: packages/happy-cli/src/daemon/jobs/cronTypes.ts
 */
export interface CronScheduleView {
    id: string;
    cronExpr: string;
    directory: string;
    prompt: string;
    tier: 'trusted' | 'supervised';
    preset: string;
    maxBudgetUsd?: number;
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string[];
    enabled: boolean;
    createdAt: number;
}

export async function machineSubmitCron(machineId: string, params: {
    cronExpr: string;
    directory: string;
    prompt: string;
    tier?: 'trusted' | 'supervised';
    preset?: string;
    maxBudgetUsd?: number;
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string[];
}): Promise<{ cronId: string }> {
    const result = await apiSocket.machineRPC<{ cronId: string }, typeof params>(
        machineId,
        'submit-cron',
        params
    );
    return result;
}

export async function machineListCrons(machineId: string): Promise<CronScheduleView[]> {
    try {
        const result = await apiSocket.machineRPC<{ crons: CronScheduleView[] }, {}>(
            machineId,
            'list-crons',
            {}
        );
        return result.crons;
    } catch (e) {
        console.warn(`machineListCrons failed for machine ${machineId}:`, e);
        return [];
    }
}

export async function machineDeleteCron(machineId: string, id: string): Promise<{ deleted: boolean }> {
    const result = await apiSocket.machineRPC<{ deleted: boolean }, { id: string }>(
        machineId,
        'delete-cron',
        { id }
    );
    return result;
}
