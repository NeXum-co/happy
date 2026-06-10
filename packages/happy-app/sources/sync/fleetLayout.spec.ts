import { describe, expect, it } from 'vitest';
import { computeFleetLayout, FleetSessionLike } from './fleetLayout';

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
