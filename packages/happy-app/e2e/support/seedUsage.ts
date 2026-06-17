// Deterministic usage seeding for the activity-dashboard web-E2E (E08 sweep).
//
// The activity view reads token/cost from the relay's UsageReport (POST /v1/usage/query), which is
// populated over the user-scoped socket `usage-report` event (same path the happy-cli uses). We seed
// one report per ACTIVE seeded session with distinctive amounts so the specs can assert AC-2/AC-3
// against exact numbers. Reports get createdAt=now, so they land in today/7d/30d windows.

import { io } from 'socket.io-client';

export interface SeededUsage {
    /** Per active-session expectations, keyed by seed tag. */
    perTag: Record<string, { tokens: number; cost: number; basename: string }>;
    totalTokens: number;
    totalCost: number;
}

// tag -> { tokens.total, cost.total, the path basename the activity rollup renders }
const USAGE: Record<string, { tokens: number; cost: number; basename: string }> = {
    'e2e-alpha-needs-you': { tokens: 1000, cost: 1.5, basename: 'service' },
    'e2e-alpha-local': { tokens: 2000, cost: 2.0, basename: 'worker' },
    'e2e-beta-idle': { tokens: 3000, cost: 3.0, basename: 'api' },
};

async function reportUsage(
    socket: ReturnType<typeof io>,
    sessionId: string,
    tokens: number,
    cost: number,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`seedUsage: usage-report ack timeout for ${sessionId}`)), 10_000);
        socket.emit(
            'usage-report',
            {
                key: 'e2e',
                sessionId,
                tokens: { total: tokens, input: Math.round(tokens * 0.7), output: Math.round(tokens * 0.3) },
                cost: { total: cost },
            },
            (ack: { success?: boolean; error?: string } | undefined) => {
                clearTimeout(timer);
                if (ack?.success) resolve();
                else reject(new Error(`seedUsage: usage-report rejected for ${sessionId}: ${JSON.stringify(ack)}`));
            },
        );
    });
}

/**
 * Seed UsageReport rows for the active seeded sessions. `sessionsByTag` maps each seed tag to its
 * session id (from seedSessions). Returns the deterministic totals for spec assertions.
 */
export async function seedUsage(
    relayUrl: string,
    token: string,
    sessionsByTag: Record<string, string>,
): Promise<SeededUsage> {
    const socket = io(relayUrl, {
        auth: { token, clientType: 'user-scoped', happyClient: 'e2e-seed/0' },
        path: '/v1/updates',
        reconnection: false,
        withCredentials: true,
        transports: ['websocket'],
    });

    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('seedUsage: user-scoped socket connect timeout')), 10_000);
            socket.on('connect', () => { clearTimeout(timer); resolve(); });
            socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
        });

        let totalTokens = 0;
        let totalCost = 0;
        const perTag: SeededUsage['perTag'] = {};
        for (const [tag, amount] of Object.entries(USAGE)) {
            const sessionId = sessionsByTag[tag];
            if (!sessionId) continue;
            await reportUsage(socket, sessionId, amount.tokens, amount.cost);
            perTag[tag] = amount;
            totalTokens += amount.tokens;
            totalCost += amount.cost;
        }
        return { perTag, totalTokens, totalCost };
    } finally {
        socket.close();
    }
}
