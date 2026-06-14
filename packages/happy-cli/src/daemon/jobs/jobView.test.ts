import { describe, it, expect } from 'vitest'
import type { JobRecord } from './jobTypes'
import { toJobRecordView, type JobRecordView } from './jobView'

const fullRecord: JobRecord = {
    id: 'job-001',
    triggerType: 'manual',
    triggerMetadata: '{"source":"test"}',
    tier: 'trusted',
    preset: 'local-qwen',
    directory: '/tmp/work',
    prompt: 'Do the thing',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    sessionId: 'sess-abc',
    scheduledAt: 1700000001000,
    claimedAt: 1700000002000,
    timeoutAt: 1700000003000,
    finishedAt: 1700000004000,
    exitReason: 'done',
    costUsd: 0.01,
    maxBudgetUsd: 1.0,
    maxTurns: 10,
    gitHeadBefore: 'abc123',
    gitHeadAfter: 'def456',
    createdAt: 1700000000000,
}

describe('toJobRecordView', () => {
    it('passes all JobRecord fields through except triggerMetadata', () => {
        const view = toJobRecordView(fullRecord)

        expect(view.id).toBe('job-001')
        expect(view.triggerType).toBe('manual')
        expect(view.tier).toBe('trusted')
        expect(view.preset).toBe('local-qwen')
        expect(view.directory).toBe('/tmp/work')
        expect(view.prompt).toBe('Do the thing')
        expect(view.status).toBe('pending')
        expect(view.attempts).toBe(0)
        expect(view.maxAttempts).toBe(5)
        expect(view.sessionId).toBe('sess-abc')
        expect(view.scheduledAt).toBe(1700000001000)
        expect(view.claimedAt).toBe(1700000002000)
        expect(view.timeoutAt).toBe(1700000003000)
        expect(view.finishedAt).toBe(1700000004000)
        expect(view.exitReason).toBe('done')
        expect(view.costUsd).toBe(0.01)
        expect(view.maxBudgetUsd).toBe(1.0)
        expect(view.maxTurns).toBe(10)
        expect(view.gitHeadBefore).toBe('abc123')
        expect(view.gitHeadAfter).toBe('def456')
        expect(view.createdAt).toBe(1700000000000)

        expect('triggerMetadata' in view).toBe(false)
    })

    it('omits absent optional fields for a minimal record', () => {
        const minimal: JobRecord = {
            id: 'job-min',
            triggerType: 'manual',
            triggerMetadata: '{}',
            tier: 'trusted',
            preset: 'local-qwen',
            directory: '/tmp',
            prompt: 'minimal',
            status: 'pending',
            attempts: 0,
            maxAttempts: 5,
            createdAt: 1700000000000,
        }

        const view = toJobRecordView(minimal)

        expect('triggerMetadata' in view).toBe(false)
        expect('sessionId' in view).toBe(false)
        expect('scheduledAt' in view).toBe(false)
        expect('claimedAt' in view).toBe(false)
        expect('timeoutAt' in view).toBe(false)
        expect('finishedAt' in view).toBe(false)
        expect('exitReason' in view).toBe(false)
        expect('costUsd' in view).toBe(false)
        expect('maxBudgetUsd' in view).toBe(false)
        expect('maxTurns' in view).toBe(false)
        expect('gitHeadBefore' in view).toBe(false)
        expect('gitHeadAfter' in view).toBe(false)

        expect(view.id).toBe('job-min')
        expect(view.createdAt).toBe(1700000000000)
    })
})
