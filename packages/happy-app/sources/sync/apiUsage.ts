import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export interface UsageDataPoint {
    timestamp: number;
    tokens: Record<string, number>;
    cost: Record<string, number>;
    reportCount: number;
}

export interface UsageQueryParams {
    sessionId?: string;
    startTime?: number; // Unix timestamp in seconds
    endTime?: number;   // Unix timestamp in seconds
    groupBy?: 'hour' | 'day';
}

export interface UsageResponse {
    usage: UsageDataPoint[];
}

/**
 * Query usage data from the server
 */
export async function queryUsage(
    credentials: AuthCredentials,
    params: UsageQueryParams = {}
): Promise<UsageResponse> {
    const API_ENDPOINT = getServerUrl();
    
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/usage/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify(params)
        });

        if (!response.ok) {
            if (response.status === 404 && params.sessionId) {
                // A session with no usage rows is a normal, terminal answer — not a
                // retryable failure. Returning empty avoids `backoff` retrying forever
                // (and a single such session stalling the whole per-session load).
                return { usage: [] };
            }
            throw new Error(`Failed to query usage: ${response.status}`);
        }

        const data = await response.json() as UsageResponse;
        return data;
    });
}

export type UsagePeriod = 'today' | '7days' | '30days';

/**
 * Start of a usage period as a Unix timestamp in seconds. Exposed so callers
 * (per-session queries) can use the exact period boundary instead of guessing
 * it from the first returned data point.
 */
export function getPeriodStartTime(
    period: UsagePeriod,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
    const oneDaySeconds = 24 * 60 * 60;
    switch (period) {
        case 'today': {
            const today = new Date(nowSeconds * 1000);
            today.setHours(0, 0, 0, 0);
            return Math.floor(today.getTime() / 1000);
        }
        case '7days':
            return nowSeconds - 7 * oneDaySeconds;
        case '30days':
            return nowSeconds - 30 * oneDaySeconds;
    }
}

/**
 * Helper function to get usage for a specific time period
 */
export async function getUsageForPeriod(
    credentials: AuthCredentials,
    period: UsagePeriod,
    sessionId?: string
): Promise<UsageResponse> {
    const now = Math.floor(Date.now() / 1000);
    const groupBy: 'hour' | 'day' = period === 'today' ? 'hour' : 'day';

    return queryUsage(credentials, {
        sessionId,
        startTime: getPeriodStartTime(period, now),
        endTime: now,
        groupBy
    });
}

/**
 * Calculate total tokens and cost from usage data
 */
export function calculateTotals(usage: UsageDataPoint[]): {
    totalTokens: number;
    totalCost: number;
    tokensByModel: Record<string, number>;
    costByModel: Record<string, number>;
} {
    const result = {
        totalTokens: 0,
        totalCost: 0,
        tokensByModel: {} as Record<string, number>,
        costByModel: {} as Record<string, number>
    };
    
    // `tokens`/`cost` are keyed by category (input, output, cache_read, cache_creation, total),
    // where `total` is the authoritative sum of the components. Use `total` directly for the
    // grand totals so we don't double-count (total + its own components). The breakdown maps
    // exclude `total` for the same reason.
    const sumComponents = (byCategory: Record<string, number>) =>
        Object.entries(byCategory).reduce((sum, [category, value]) =>
            category !== 'total' && typeof value === 'number' ? sum + value : sum, 0);

    for (const dataPoint of usage) {
        result.totalTokens += typeof dataPoint.tokens?.total === 'number'
            ? dataPoint.tokens.total
            : sumComponents(dataPoint.tokens);
        for (const [category, tokens] of Object.entries(dataPoint.tokens)) {
            if (category !== 'total' && typeof tokens === 'number') {
                result.tokensByModel[category] = (result.tokensByModel[category] || 0) + tokens;
            }
        }

        result.totalCost += typeof dataPoint.cost?.total === 'number'
            ? dataPoint.cost.total
            : sumComponents(dataPoint.cost);
        for (const [category, cost] of Object.entries(dataPoint.cost)) {
            if (category !== 'total' && typeof cost === 'number') {
                result.costByModel[category] = (result.costByModel[category] || 0) + cost;
            }
        }
    }
    
    return result;
}