import { describe, expect, it } from 'vitest';
import { computeAgentAttention, computeFleetLayout, FleetSessionLike } from './fleetLayout';

function fleetSession(overrides: Partial<FleetSessionLike> & { id: string }): FleetSessionLike {
    return {
        active: true,
        activeAt: 0,
        createdAt: 0,
        needsYou: false,
        path: '/home/user/code/alpha',
        homeDir: '/home/user',
        ...overrides,
    };
}

describe('computeFleetLayout (stabiele-sort, E02)', () => {
    // Distinct createdAt + deliberately INVERSE activeAt, so a test that passes
    // can only be ordering by the stable key (createdAt/id), never by activeAt.
    const sessions: FleetSessionLike[] = [
        fleetSession({ id: 'needs-old', needsYou: true, createdAt: 10, activeAt: 100, path: '/home/user/code/beta' }),
        fleetSession({ id: 'inactive', active: false, createdAt: 50, activeAt: 50 }),
        fleetSession({ id: 'alpha-b', createdAt: 30, activeAt: 200, path: '/home/user/code/alpha/packages/app' }),
        fleetSession({ id: 'needs-new', needsYou: true, createdAt: 20, activeAt: 300, path: '/home/user/code/alpha' }),
        fleetSession({ id: 'alpha-a', createdAt: 40, activeAt: 400, path: '/home/user/code/alpha' }),
    ];

    it('puts needs-you sessions in the band, oldest-created first (stable), across all projects', () => {
        const layout = computeFleetLayout(sessions);
        // createdAt 10 < 20 → needs-old first, even though needs-new has the higher activeAt.
        expect(layout.needsYou.map(s => s.id)).toEqual(['needs-old', 'needs-new']);
    });

    it('groups remaining active sessions per project key, oldest-created first within the group', () => {
        const layout = computeFleetLayout(sessions);
        expect(layout.projectGroups).toHaveLength(1);
        expect(layout.projectGroups[0].key).toBe('alpha');
        // createdAt 30 < 40 → alpha-b first, even though alpha-a has the higher activeAt.
        expect(layout.projectGroups[0].sessions.map(s => s.id)).toEqual(['alpha-b', 'alpha-a']);
    });

    it('excludes needs-you sessions from the project groups', () => {
        const layout = computeFleetLayout(sessions);
        const groupedIds = layout.projectGroups.flatMap(g => g.sessions.map(s => s.id));
        expect(groupedIds).not.toContain('needs-new');
        expect(groupedIds).not.toContain('needs-old');
    });

    it('keeps inactive sessions separate, newest created first (createdAt is immutable → stable)', () => {
        const layout = computeFleetLayout([
            ...sessions,
            fleetSession({ id: 'inactive-newer', active: false, createdAt: 80 }),
        ]);
        expect(layout.inactive.map(s => s.id)).toEqual(['inactive-newer', 'inactive']);
    });

    it('orders project groups alphabetically by key (stable), sessions within by createdAt', () => {
        const layout = computeFleetLayout([
            fleetSession({ id: 'old-project', createdAt: 11, activeAt: 10, path: '/home/user/code/beta' }),
            fleetSession({ id: 'recent-project', createdAt: 99, activeAt: 500, path: '/home/user/code/webshop--e02' }),
            fleetSession({ id: 'old-project-2', createdAt: 22, activeAt: 20, path: '/home/user/code/beta/api' }),
        ]);
        // Alphabetical by key, NOT by most-recent activity (webshop has the higher activeAt).
        expect(layout.projectGroups.map(g => g.key)).toEqual(['beta', 'webshop']);
        // Within beta: createdAt 11 < 22 → old-project first.
        expect(layout.projectGroups[0].sessions.map(s => s.id)).toEqual(['old-project', 'old-project-2']);
    });

    it('keeps the SAME order when only activeAt changes — no jump on heartbeats (the core fix)', () => {
        const base = computeFleetLayout(sessions);
        // Simulate heartbeats: bump every activeAt arbitrarily (and invert relative order).
        const ticked = computeFleetLayout(sessions.map(s => ({ ...s, activeAt: 1_000_000 - s.activeAt })));
        expect(ticked.needsYou.map(s => s.id)).toEqual(base.needsYou.map(s => s.id));
        expect(ticked.projectGroups.map(g => g.key)).toEqual(base.projectGroups.map(g => g.key));
        expect(ticked.projectGroups[0].sessions.map(s => s.id)).toEqual(base.projectGroups[0].sessions.map(s => s.id));
        expect(ticked.inactive.map(s => s.id)).toEqual(base.inactive.map(s => s.id));
    });
});

describe('computeAgentAttention', () => {
    it('flags remote attention for open permission requests', () => {
        const attention = computeAgentAttention({
            requests: { 'req-1': { tool: 'Bash', arguments: {}, createdAt: 1 } },
        });
        expect(attention).toEqual({ remote: true, local: false });
    });

    it('flags local attention for a terminal permission prompt (localRequest, AC-6)', () => {
        const attention = computeAgentAttention({
            localRequest: { message: 'Claude needs your permission to use Bash', createdAt: 1 },
        }, 1_000);
        expect(attention).toEqual({ remote: false, local: true });
    });

    it('flags both when remote requests and a localRequest coexist', () => {
        const attention = computeAgentAttention({
            requests: { 'req-1': { tool: 'Bash', arguments: {}, createdAt: 1 } },
            localRequest: { message: 'Permission required', createdAt: 1 },
        }, 1_000);
        expect(attention).toEqual({ remote: true, local: true });
    });

    it('flags nothing for empty requests, a cleared localRequest, or missing agentState', () => {
        expect(computeAgentAttention({ requests: {}, localRequest: null })).toEqual({ remote: false, local: false });
        expect(computeAgentAttention(null)).toEqual({ remote: false, local: false });
        expect(computeAgentAttention(undefined)).toEqual({ remote: false, local: false });
    });

    // TTL safety net (D-E02-13): an interactive deny in the Claude TUI fires
    // no hook event, so a localRequest can go stale; ignore it after 30 min.
    it('ignores a localRequest older than 30 minutes (TTL, D-E02-13)', () => {
        const now = 100 * 60 * 1000;
        expect(computeAgentAttention({
            localRequest: { message: 'Claude needs your permission', createdAt: now - 31 * 60 * 1000 },
        }, now)).toEqual({ remote: false, local: false });
    });

    it('still flags a localRequest younger than 30 minutes', () => {
        const now = 100 * 60 * 1000;
        expect(computeAgentAttention({
            localRequest: { message: 'Claude needs your permission', createdAt: now - 29 * 60 * 1000 },
        }, now)).toEqual({ remote: false, local: true });
    });

    it('keeps remote attention when the localRequest is stale', () => {
        const now = 100 * 60 * 1000;
        expect(computeAgentAttention({
            requests: { 'req-1': { tool: 'Bash', arguments: {}, createdAt: 1 } },
            localRequest: { message: 'Claude needs your permission', createdAt: now - 31 * 60 * 1000 },
        }, now)).toEqual({ remote: true, local: false });
    });
});
