import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'http://test.local' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'test-client' }));

import { getPeriodStartTime, queryUsage } from './apiUsage';
import { AuthCredentials } from '@/auth/tokenStorage';

const creds: AuthCredentials = { token: 'tok', secret: 'sec' };
const DAY = 24 * 60 * 60;

describe('getPeriodStartTime', () => {
    it('subtracts whole days for the rolling windows', () => {
        const now = 1_000_000;
        expect(getPeriodStartTime('7days', now)).toBe(now - 7 * DAY);
        expect(getPeriodStartTime('30days', now)).toBe(now - 30 * DAY);
    });

    it('returns the start of the local day for "today", within the last 24h', () => {
        const now = Math.floor(Date.now() / 1000);
        const start = getPeriodStartTime('today', now);
        expect(start).toBeLessThanOrEqual(now);
        expect(now - start).toBeLessThan(DAY);
    });
});

describe('queryUsage', () => {
    beforeEach(() => vi.unstubAllGlobals());

    it('resolves to empty usage when a per-session query 404s (no infinite retry)', { timeout: 3000 }, async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as Response));
        const res = await queryUsage(creds, { sessionId: 's1' });
        expect(res.usage).toEqual([]);
    });

    it('returns the server payload on success', async () => {
        const payload = { usage: [{ timestamp: 1, tokens: { total: 5 }, cost: { total: 0.1 }, reportCount: 1 }] };
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response));
        const res = await queryUsage(creds, { sessionId: 's1' });
        expect(res.usage).toHaveLength(1);
        expect(res.usage[0].tokens.total).toBe(5);
    });
});
