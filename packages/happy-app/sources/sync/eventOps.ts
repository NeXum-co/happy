import { apiSocket } from './apiSocket';

/**
 * Mirror of the EventSubscriptionView type from the daemon's event store.
 * Source of truth: packages/happy-cli/src/daemon/jobs/eventTypes.ts
 */
export interface EventSubscriptionView {
    id: string;
    eventType: string;
    matchKey?: string;
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

export async function machineSubmitEventSubscription(machineId: string, params: {
    eventType: string;
    matchKey?: string;
    directory: string;
    prompt: string;
    tier?: 'trusted' | 'supervised';
    preset?: string;
    maxBudgetUsd?: number;
    maxTurns?: number;
    timeoutMs?: number;
    allowedTools?: string[];
    dispositionTopic?: string;
}): Promise<{ subscriptionId: string }> {
    const { dispositionTopic, ...rest } = params;
    const payload = { ...rest, ...(dispositionTopic ? { dispositionTopic } : {}) };
    const result = await apiSocket.machineRPC<{ subscriptionId: string }, typeof payload>(
        machineId,
        'submit-event-subscription',
        payload
    );
    return result;
}

export async function machineListEventSubscriptions(machineId: string): Promise<EventSubscriptionView[]> {
    try {
        const result = await apiSocket.machineRPC<{ subscriptions: EventSubscriptionView[] }, {}>(
            machineId,
            'list-event-subscriptions',
            {}
        );
        return result.subscriptions;
    } catch (e) {
        console.warn(`machineListEventSubscriptions failed for machine ${machineId}:`, e);
        return [];
    }
}

export async function machineDeleteEventSubscription(machineId: string, id: string): Promise<{ deleted: boolean }> {
    const result = await apiSocket.machineRPC<{ deleted: boolean }, { id: string }>(
        machineId,
        'delete-event-subscription',
        { id }
    );
    return result;
}
