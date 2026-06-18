import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the transport before importing the module under test so the static
// `import { apiSocket }` in runOps.ts binds to the mock.
vi.mock('./apiSocket', () => ({
    apiSocket: {
        machineRPC: vi.fn(),
    },
}));

import { apiSocket } from './apiSocket';
import {
    machineSubmitJob,
    machineStopJob,
    machineCancelJob,
    machineListJobs,
    machineGetJob,
    type JobRecordView,
} from './runOps';

const machineRPC = apiSocket.machineRPC as unknown as ReturnType<typeof vi.fn>;

const MACHINE_ID = 'machine-abc';

function makeJob(overrides: Partial<JobRecordView> = {}): JobRecordView {
    return {
        id: 'job-1',
        triggerType: 'manual',
        tier: 'trusted',
        preset: 'default',
        directory: '/repo',
        prompt: 'do the thing',
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        createdAt: 1000,
        ...overrides,
    };
}

describe('runOps machine RPC verbs', () => {
    beforeEach(() => {
        machineRPC.mockReset();
    });

    describe('machineSubmitJob', () => {
        it('calls the submit-job method with the params shape and returns { jobId }', async () => {
            machineRPC.mockResolvedValue({ jobId: 'job-42' });
            const params = { directory: '/repo', prompt: 'go', tier: 'trusted' as const };

            const result = await machineSubmitJob(MACHINE_ID, params);

            expect(machineRPC).toHaveBeenCalledTimes(1);
            expect(machineRPC).toHaveBeenCalledWith(MACHINE_ID, 'submit-job', params);
            expect(result).toEqual({ jobId: 'job-42' });
        });

        it('does NOT swallow errors (submit failures must surface)', async () => {
            machineRPC.mockRejectedValue(new Error('relay down'));
            await expect(
                machineSubmitJob(MACHINE_ID, { directory: '/r', prompt: 'p' }),
            ).rejects.toThrow('relay down');
        });
    });

    describe('machineStopJob', () => {
        it('calls stop-job with { sessionId } and returns { stopped }', async () => {
            machineRPC.mockResolvedValue({ stopped: true });

            const result = await machineStopJob(MACHINE_ID, 'session-7');

            expect(machineRPC).toHaveBeenCalledTimes(1);
            expect(machineRPC).toHaveBeenCalledWith(MACHINE_ID, 'stop-job', { sessionId: 'session-7' });
            expect(result).toEqual({ stopped: true });
        });

        it('does NOT swallow errors', async () => {
            machineRPC.mockRejectedValue(new Error('boom'));
            await expect(machineStopJob(MACHINE_ID, 'session-7')).rejects.toThrow('boom');
        });
    });

    describe('machineCancelJob', () => {
        it('calls cancel-job with { jobId } and returns { cancelled }', async () => {
            machineRPC.mockResolvedValue({ cancelled: true });

            const result = await machineCancelJob(MACHINE_ID, 'job-9');

            expect(machineRPC).toHaveBeenCalledTimes(1);
            expect(machineRPC).toHaveBeenCalledWith(MACHINE_ID, 'cancel-job', { jobId: 'job-9' });
            expect(result).toEqual({ cancelled: true });
        });

        it('does NOT swallow errors', async () => {
            machineRPC.mockRejectedValue(new Error('boom'));
            await expect(machineCancelJob(MACHINE_ID, 'job-9')).rejects.toThrow('boom');
        });
    });

    describe('machineListJobs', () => {
        it('calls list-jobs with {} when no status and returns the unwrapped .jobs array', async () => {
            const jobs = [makeJob({ id: 'a' }), makeJob({ id: 'b' })];
            machineRPC.mockResolvedValue({ jobs });

            const result = await machineListJobs(MACHINE_ID);

            expect(machineRPC).toHaveBeenCalledTimes(1);
            expect(machineRPC).toHaveBeenCalledWith(MACHINE_ID, 'list-jobs', {});
            expect(result).toBe(jobs);
            expect(result).toHaveLength(2);
        });

        it('calls list-jobs with { status } only when a status is passed', async () => {
            machineRPC.mockResolvedValue({ jobs: [] });

            await machineListJobs(MACHINE_ID, 'running');

            expect(machineRPC).toHaveBeenCalledWith(MACHINE_ID, 'list-jobs', { status: 'running' });
        });

        it('swallows errors and returns [] (never-show-loading-error contract)', async () => {
            machineRPC.mockRejectedValue(new Error('relay down'));

            const result = await machineListJobs(MACHINE_ID);

            expect(result).toEqual([]);
        });
    });

    describe('machineGetJob', () => {
        it('calls get-job with { id } and returns the unwrapped .job value', async () => {
            const job = makeJob({ id: 'job-77' });
            machineRPC.mockResolvedValue({ job });

            const result = await machineGetJob(MACHINE_ID, 'job-77');

            expect(machineRPC).toHaveBeenCalledTimes(1);
            expect(machineRPC).toHaveBeenCalledWith(MACHINE_ID, 'get-job', { id: 'job-77' });
            expect(result).toBe(job);
        });

        it('returns the null job when the daemon reports it missing', async () => {
            machineRPC.mockResolvedValue({ job: null });

            const result = await machineGetJob(MACHINE_ID, 'missing');

            expect(result).toBeNull();
        });

        it('swallows errors and returns null (never-show-loading-error contract)', async () => {
            machineRPC.mockRejectedValue(new Error('relay down'));

            const result = await machineGetJob(MACHINE_ID, 'job-77');

            expect(result).toBeNull();
        });
    });
});
