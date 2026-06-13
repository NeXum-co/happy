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
                throw new Error('Session not found');
            }
            throw new Error(`Failed to query usage: ${response.status}`);
        }

        const data = await response.json() as UsageResponse;
        return data;
    });
}

/**
 * Helper function to get usage for a specific time period
 */
export async function getUsageForPeriod(
    credentials: AuthCredentials,
    period: 'today' | '7days' | '30days',
    sessionId?: string
): Promise<UsageResponse> {
    const now = Math.floor(Date.now() / 1000);
    const oneDaySeconds = 24 * 60 * 60;
    
    let startTime: number;
    let groupBy: 'hour' | 'day';
    
    switch (period) {
        case 'today':
            // Start of today (local timezone)
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            startTime = Math.floor(today.getTime() / 1000);
            groupBy = 'hour';
            break;
        case '7days':
            startTime = now - (7 * oneDaySeconds);
            groupBy = 'day';
            break;
        case '30days':
            startTime = now - (30 * oneDaySeconds);
            groupBy = 'day';
            break;
    }
    
    return queryUsage(credentials, {
        sessionId,
        startTime,
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