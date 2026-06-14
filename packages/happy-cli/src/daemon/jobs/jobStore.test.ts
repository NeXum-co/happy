/**
 * Unit tests for the durable SQLite job store.
 *
 * Each test uses a fresh tmp db file. create/get round-trips a full record
 * (optionals absent stay undefined). claimNext atomically hands out the oldest
 * eligible pending job and flips it to running. recoverOnStartup re-queues
 * running jobs whose timeoutAt has passed, leaving future-timeout jobs alone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from './jobStore'
import type { JobRecord } from './jobTypes'

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    triggerType: 'manual',
    triggerMetadata: '{}',
    tier: 'trusted',
    preset: 'local-qwen',
    directory: '/tmp/work',
    prompt: 'do the thing',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    createdAt: 1000,
    ...overrides,
  }
}

describe('JobStore', () => {
  let dir: string
  let store: JobStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-jobstore-test-'))
    store = new JobStore(join(dir, 'jobs.db'))
    store.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a full record through create + get', () => {
    const job = makeJob({
      id: 'job-rt',
      sessionId: 'sess-9',
      scheduledAt: 1500,
      costUsd: 0.42,
    })
    store.create(job)

    const loaded = store.get('job-rt')
    expect(loaded).toBeDefined()
    expect(loaded!.id).toBe('job-rt')
    expect(loaded!.sessionId).toBe('sess-9')
    expect(loaded!.scheduledAt).toBe(1500)
    expect(loaded!.costUsd).toBe(0.42)
    // optionals left undefined stay undefined
    expect(loaded!.claimedAt).toBeUndefined()
    expect(loaded!.finishedAt).toBeUndefined()
    expect(loaded!.exitReason).toBeUndefined()
  })

  it('round-trips maxBudgetUsd and maxTurns', () => {
    store.create(makeJob({ id: 'job-limits', maxBudgetUsd: 2.5, maxTurns: 40 }))

    const loaded = store.get('job-limits')!
    expect(loaded.maxBudgetUsd).toBe(2.5)
    expect(loaded.maxTurns).toBe(40)

    // absent → undefined
    store.create(makeJob({ id: 'job-nolimits' }))
    const bare = store.get('job-nolimits')!
    expect(bare.maxBudgetUsd).toBeUndefined()
    expect(bare.maxTurns).toBeUndefined()
  })

  it('patch updates fields without a status transition', () => {
    store.create(makeJob({ id: 'job-patch', status: 'running' }))

    store.patch('job-patch', { sessionId: 'sess-42' })

    const loaded = store.get('job-patch')!
    expect(loaded.sessionId).toBe('sess-42')
    expect(loaded.status).toBe('running') // unchanged — no transition
  })

  it('returns undefined for an unknown id', () => {
    expect(store.get('nope')).toBeUndefined()
  })

  it('claimNext hands out the oldest pending job, then the next, then undefined', () => {
    store.create(makeJob({ id: 'older', createdAt: 1000 }))
    store.create(makeJob({ id: 'newer', createdAt: 2000 }))

    const first = store.claimNext(5000)
    expect(first).toBeDefined()
    expect(first!.id).toBe('older')
    expect(first!.status).toBe('running')
    expect(first!.claimedAt).toBe(5000)
    expect(store.get('older')!.status).toBe('running')

    const second = store.claimNext(6000)
    expect(second!.id).toBe('newer')
    expect(second!.status).toBe('running')

    const third = store.claimNext(7000)
    expect(third).toBeUndefined()
  })

  it('claimNext skips jobs scheduled in the future', () => {
    store.create(makeJob({ id: 'future', createdAt: 1000, scheduledAt: 9000 }))

    expect(store.claimNext(5000)).toBeUndefined()
    const claimed = store.claimNext(9000)
    expect(claimed!.id).toBe('future')
  })

  it('recoverOnStartup re-queues timed-out running jobs and leaves future ones', () => {
    store.create(makeJob({ id: 'stale', status: 'running', timeoutAt: 100, attempts: 2 }))
    store.create(makeJob({ id: 'fresh', status: 'running', timeoutAt: 9000, attempts: 1 }))

    const recovered = store.recoverOnStartup(5000)
    expect(recovered).toBe(1)

    const stale = store.get('stale')!
    expect(stale.status).toBe('pending')
    expect(stale.attempts).toBe(2) // attempts unchanged

    expect(store.get('fresh')!.status).toBe('running')
  })

  it('list filters by status', () => {
    store.create(makeJob({ id: 'p1', status: 'pending' }))
    store.create(makeJob({ id: 'r1', status: 'running' }))

    expect(store.list().length).toBe(2)
    expect(store.list({ status: 'pending' }).map(j => j.id)).toEqual(['p1'])
  })

  it('transition rejects an illegal edge', () => {
    store.create(makeJob({ id: 'j', status: 'running' }))
    expect(() => store.transition('j', 'dead')).toThrow()
  })
})
