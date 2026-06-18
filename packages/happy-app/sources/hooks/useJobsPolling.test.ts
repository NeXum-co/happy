import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// react-test-renderer's act() needs this flag in a non-DOM (node) env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Faithful stand-in for expo-router's focus effect: run the callback when the
// screen "focuses" (mount) and run its returned cleanup on blur/unmount. This
// mirrors the real contract the hook depends on (callback runs, cleanup runs).
vi.mock('expo-router', () => ({
    useFocusEffect: (cb: () => (() => void) | void) => {
        React.useEffect(() => cb(), [cb]);
    },
}));

// Mock the data source so we control resolution timing.
vi.mock('@/sync/runOps', () => ({
    machineListJobs: vi.fn(),
}));

import { machineListJobs, type JobRecordView } from '@/sync/runOps';
import { useJobsPolling } from './useJobsPolling';

const listJobs = machineListJobs as unknown as ReturnType<typeof vi.fn>;

function makeJob(id: string): JobRecordView {
    return {
        id,
        triggerType: 'manual',
        tier: 'trusted',
        preset: 'default',
        directory: '/repo',
        prompt: 'p',
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        createdAt: 1000,
    };
}

/**
 * Renders the hook and exposes the latest returned value plus an unmount handle.
 * `captured` always reflects the most recent render so tests can assert state.
 */
function renderJobsPolling(machineId: string | null) {
    const captured: { jobs: JobRecordView[] } = { jobs: [] };
    function Harness({ id }: { id: string | null }) {
        const result = useJobsPolling(id);
        captured.jobs = result.jobs;
        return null;
    }
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
        renderer = TestRenderer.create(React.createElement(Harness, { id: machineId }));
    });
    return {
        captured,
        rerender: (id: string | null) =>
            act(() => renderer.update(React.createElement(Harness, { id }))),
        unmount: () => act(() => renderer.unmount()),
    };
}

describe('useJobsPolling', () => {
    beforeEach(() => {
        listJobs.mockReset();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fetches and exposes jobs on focus when a machineId is present', async () => {
        const jobs = [makeJob('a'), makeJob('b')];
        listJobs.mockResolvedValue(jobs);

        const { captured, unmount } = renderJobsPolling('machine-1');

        // Flush the awaited tick() inside the focus effect.
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(listJobs).toHaveBeenCalledWith('machine-1');
        expect(captured.jobs).toBe(jobs);
        unmount();
    });

    it('stays idle with machineId === null: no poll, empty list', async () => {
        const { captured, unmount } = renderJobsPolling(null);

        await act(async () => {
            await Promise.resolve();
        });
        // Advance well past the poll interval; nothing should fire.
        await act(async () => {
            vi.advanceTimersByTime(10_000);
            await Promise.resolve();
        });

        expect(listJobs).not.toHaveBeenCalled();
        expect(captured.jobs).toEqual([]);
        unmount();
    });

    it('re-polls every 2000ms while focused', async () => {
        listJobs.mockResolvedValue([makeJob('a')]);

        const { unmount } = renderJobsPolling('machine-1');

        // Initial tick on focus.
        await act(async () => { await Promise.resolve(); });
        expect(listJobs).toHaveBeenCalledTimes(1);

        // One interval -> second fetch.
        await act(async () => {
            vi.advanceTimersByTime(2000);
            await Promise.resolve();
        });
        expect(listJobs).toHaveBeenCalledTimes(2);

        // Another interval -> third fetch.
        await act(async () => {
            vi.advanceTimersByTime(2000);
            await Promise.resolve();
        });
        expect(listJobs).toHaveBeenCalledTimes(3);

        unmount();
    });

    it('stops polling after unmount (clearInterval on cleanup)', async () => {
        listJobs.mockResolvedValue([makeJob('a')]);

        const { unmount } = renderJobsPolling('machine-1');
        await act(async () => { await Promise.resolve(); });
        expect(listJobs).toHaveBeenCalledTimes(1);

        unmount();

        await act(async () => {
            vi.advanceTimersByTime(10_000);
            await Promise.resolve();
        });
        // No further fetches after the effect is torn down.
        expect(listJobs).toHaveBeenCalledTimes(1);
    });

    it('does NOT apply a stale in-flight fetch after the effect is torn down (cancellable-effect guard)', async () => {
        // First fetch (machine-1) is deferred so it stays in flight while the
        // effect tears down. Second fetch (machine-2) resolves immediately.
        let resolveStale!: (jobs: JobRecordView[]) => void;
        const stalePromise = new Promise<JobRecordView[]>((resolve) => {
            resolveStale = resolve;
        });
        const freshJobs = [makeJob('fresh')];
        listJobs
            .mockReturnValueOnce(stalePromise) // machine-1: never resolves until we say so
            .mockResolvedValue(freshJobs); // machine-2 and onward

        const { captured, rerender, unmount } = renderJobsPolling('machine-1');

        // machine-1 focus effect fired; its fetch is in flight, state still empty.
        expect(listJobs).toHaveBeenNthCalledWith(1, 'machine-1');
        expect(captured.jobs).toEqual([]);

        // machineId changes -> machine-1 effect cleanup runs (sets cancelled=true),
        // machine-2 effect runs and resolves with fresh data.
        rerender('machine-2');
        await act(async () => { await Promise.resolve(); });
        expect(listJobs).toHaveBeenNthCalledWith(2, 'machine-2');
        expect(captured.jobs).toBe(freshJobs);

        // Now the stale machine-1 fetch finally resolves. Without the `cancelled`
        // guard this would clobber the current machine-2 state.
        await act(async () => {
            resolveStale([makeJob('stale')]);
            await Promise.resolve();
            await Promise.resolve();
        });

        // Fresh data survives; the late stale payload was dropped.
        expect(captured.jobs).toBe(freshJobs);

        unmount();
    });
});
