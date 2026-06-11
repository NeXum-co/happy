import { describe, expect, it } from 'vitest';
import { computeAgentAttention, computeFleetLayout, FleetSessionLike } from './fleetLayout';

function fleetSession(overrides: Partial<FleetSessionLike> & { id: string }): FleetSessionLike {
    return {
        active: true,
        activeAt: 0,
        createdAt: 0,
        needsYou: false,
        path: '/home/joshuam/code/nexum',
        homeDir: '/home/joshuam',
        ...overrides,
    };
}

describe('computeFleetLayout', () => {
    // Fixture from the buildplan: 2 needs-you, 2 active in the same project, 1 inactive
    const sessions: FleetSessionLike[] = [
        fleetSession({ id: 'needs-old', needsYou: true, activeAt: 100, path: '/home/joshuam/code/proxuma' }),
        fleetSession({ id: 'inactive', active: false, createdAt: 50, activeAt: 50 }),
        fleetSession({ id: 'nexum-b', activeAt: 200, path: '/home/joshuam/code/nexum/packages/app' }),
        fleetSession({ id: 'needs-new', needsYou: true, activeAt: 300, path: '/home/joshuam/code/nexum' }),
        fleetSession({ id: 'nexum-a', activeAt: 400, path: '/home/joshuam/code/nexum' }),
    ];

    it('puts needs-you sessions in the band, most recent first, across all projects', () => {
        const layout = computeFleetLayout(sessions);
        expect(layout.needsYou.map(s => s.id)).toEqual(['needs-new', 'needs-old']);
    });

    it('groups remaining active sessions per project key, most recent first within the group', () => {
        const layout = computeFleetLayout(sessions);
        expect(layout.projectGroups).toHaveLength(1);
        expect(layout.projectGroups[0].key).toBe('nexum');
        expect(layout.projectGroups[0].sessions.map(s => s.id)).toEqual(['nexum-a', 'nexum-b']);
    });

    it('excludes needs-you sessions from the project groups', () => {
        const layout = computeFleetLayout(sessions);
        const groupedIds = layout.projectGroups.flatMap(g => g.sessions.map(s => s.id));
        expect(groupedIds).not.toContain('needs-new');
        expect(groupedIds).not.toContain('needs-old');
    });

    it('keeps inactive sessions separate, newest created first', () => {
        const layout = computeFleetLayout([
            ...sessions,
            fleetSession({ id: 'inactive-newer', active: false, createdAt: 80 }),
        ]);
        expect(layout.inactive.map(s => s.id)).toEqual(['inactive-newer', 'inactive']);
    });

    it('orders project groups by their most recent activity', () => {
        const layout = computeFleetLayout([
            fleetSession({ id: 'old-project', activeAt: 10, path: '/home/joshuam/code/proxuma' }),
            fleetSession({ id: 'recent-project', activeAt: 500, path: '/home/joshuam/code/control-plane--e02' }),
            fleetSession({ id: 'old-project-2', activeAt: 20, path: '/home/joshuam/code/proxuma/api' }),
        ]);
        expect(layout.projectGroups.map(g => g.key)).toEqual(['control-plane', 'proxuma']);
        expect(layout.projectGroups[1].sessions.map(s => s.id)).toEqual(['old-project-2', 'old-project']);
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
