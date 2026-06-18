import { describe, expect, it } from 'vitest';
import { computeActivityLayout, ActivitySessionLike } from './activityLayout';

function activitySession(overrides: Partial<ActivitySessionLike> & { id: string }): ActivitySessionLike {
    return {
        active: false,
        createdAt: 0,
        activeAt: 0,
        metadata: { path: '/home/user/code/alpha', machineId: 'm1' },
        ...overrides,
    };
}

// Local-time midday timestamps on two distinct calendar days, built from
// local date components so the day-grouping is timezone-independent.
const day1 = new Date(2026, 5, 11, 12, 0, 0).getTime();
const day2 = new Date(2026, 5, 12, 12, 0, 0).getTime();
const day2Later = new Date(2026, 5, 12, 15, 0, 0).getTime();

describe('computeActivityLayout', () => {
    it('groups sessions per local calendar day, days newest first, sessions within a day newest first', () => {
        const layout = computeActivityLayout([
            activitySession({ id: 'd1', createdAt: day1, activeAt: day1 }),
            activitySession({ id: 'd2-early', createdAt: day2, activeAt: day2 }),
            activitySession({ id: 'd2-late', createdAt: day2Later, activeAt: day2Later }),
        ], { now: day2Later });

        expect(layout.dayGroups).toHaveLength(2);
        expect(layout.dayGroups[0].date).toBe('2026-06-12');
        expect(layout.dayGroups[1].date).toBe('2026-06-11');
        expect(layout.dayGroups[0].sessions.map(s => s.id)).toEqual(['d2-late', 'd2-early']);
        expect(layout.dayGroups[0].totals.count).toBe(2);
        expect(layout.dayGroups[1].sessions.map(s => s.id)).toEqual(['d1']);
    });

    it('uses now for active session duration and activeAt for inactive', () => {
        const now = day1 + 10_000;
        const layout = computeActivityLayout([
            activitySession({ id: 'active', active: true, createdAt: day1, activeAt: day1 + 1_000 }),
            activitySession({ id: 'inactive', active: false, createdAt: day1, activeAt: day1 + 5_000 }),
        ], { now });

        const rows = layout.dayGroups[0].sessions;
        const active = rows.find(r => r.id === 'active')!;
        const inactive = rows.find(r => r.id === 'inactive')!;
        expect(active.durationMs).toBe(10_000);
        expect(inactive.durationMs).toBe(5_000);
    });

    it('clamps negative duration to 0 (createdAt after activeAt)', () => {
        const layout = computeActivityLayout([
            activitySession({ id: 'reversed', active: false, createdAt: day1 + 5_000, activeAt: day1 }),
        ], { now: day1 });
        expect(layout.dayGroups[0].sessions[0].durationMs).toBe(0);
    });

    it('aggregates the project rollup by machineId:project, summing count and duration and taking the max lastActiveAt', () => {
        const layout = computeActivityLayout([
            activitySession({ id: 'a', createdAt: day1, activeAt: day1 + 1_000, metadata: { path: '/p', machineId: 'm1' } }),
            activitySession({ id: 'b', createdAt: day2, activeAt: day2 + 4_000, metadata: { path: '/p', machineId: 'm1' } }),
        ], { now: day2Later });

        expect(layout.projectRollup).toHaveLength(1);
        const row = layout.projectRollup[0];
        expect(row.machineId).toBe('m1');
        expect(row.project).toBe('/p');
        expect(row.count).toBe(2);
        expect(row.durationMs).toBe(1_000 + 4_000);
        // lastActiveAt reflects when the project was last active (effective end of its
        // newest session = activeAt for inactive), not merely when it was created.
        expect(row.lastActiveAt).toBe(day2 + 4_000);
    });

    it('uses now for the lastActiveAt of an active session', () => {
        const now = day2Later + 9_000;
        const layout = computeActivityLayout([
            activitySession({ id: 'live', active: true, createdAt: day2, activeAt: day2 + 1_000, metadata: { path: '/p', machineId: 'm1' } }),
        ], { now });
        expect(layout.projectRollup[0].lastActiveAt).toBe(now);
    });

    it('keeps distinct machineId/project buckets that would collide under a naive `${a}:${b}` key', () => {
        const layout = computeActivityLayout([
            activitySession({ id: 'x', createdAt: day1, activeAt: day1, metadata: { path: 'b:c', machineId: 'a' } }),
            activitySession({ id: 'y', createdAt: day1, activeAt: day1, metadata: { path: 'c', machineId: 'a:b' } }),
        ], { now: day1 });
        expect(layout.projectRollup).toHaveLength(2);
    });

    it('handles empty input and null metadata without crashing', () => {
        expect(computeActivityLayout([], { now: day1 })).toEqual({ dayGroups: [], projectRollup: [] });

        const layout = computeActivityLayout([
            activitySession({ id: 'n', createdAt: day1, activeAt: day1, metadata: null }),
        ], { now: day1 });
        expect(layout.projectRollup).toHaveLength(1);
        expect(layout.projectRollup[0].project).toBeNull();
        expect(layout.projectRollup[0].machineId).toBeNull();
    });

    it('joins per-session cost from usageBySession and sums it in the rollup; missing entries stay undefined', () => {
        const usageBySession = new Map<string, number>([['a', 1.5]]);
        const layout = computeActivityLayout([
            activitySession({ id: 'a', createdAt: day1, activeAt: day1 + 1_000, metadata: { path: '/p', machineId: 'm1' } }),
            activitySession({ id: 'b', createdAt: day2, activeAt: day2 + 1_000, metadata: { path: '/p', machineId: 'm1' } }),
        ], { now: day2Later, usageBySession });

        const dayWithA = layout.dayGroups.find(g => g.sessions.some(s => s.id === 'a'))!;
        const rowA = dayWithA.sessions.find(s => s.id === 'a')!;
        const dayWithB = layout.dayGroups.find(g => g.sessions.some(s => s.id === 'b'))!;
        const rowB = dayWithB.sessions.find(s => s.id === 'b')!;
        expect(rowA.costUsd).toBe(1.5);
        expect(rowB.costUsd).toBeUndefined();

        expect(layout.projectRollup).toHaveLength(1);
        expect(layout.projectRollup[0].costUsd).toBe(1.5);
    });

    it('sets isAutonomous false and resolves the title via the injected getTitle', () => {
        const layout = computeActivityLayout([
            activitySession({ id: 'a', createdAt: day1, activeAt: day1 }),
        ], { now: day1, getTitle: () => 'My session' });
        const row = layout.dayGroups[0].sessions[0];
        expect(row.isAutonomous).toBe(false);
        expect(row.title).toBe('My session');
    });
});
