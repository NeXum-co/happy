/**
 * Unit tests for the cancel-pending-job behaviour (E04, M4).
 *
 * The /cancel-job control endpoint drives a non-running job to a terminal 'dead'
 * state. /stop-job (keyed by sessionId) cannot reach a pending/retrying job
 * because it has no live session. These tests run a real tmp SQLite store and
 * the real state machine to prove the exact transition path the cancelJob
 * closure in run.ts performs: pending -> failed(exitReason:'cancelled') -> dead,
 * and that a running job is refused (left running for /stop-job to handle).
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
    tier: 'supervised',
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

/**
 * Mirror of the cancelJob closure in run.ts, parameterised over a JobStore so
 * the transition logic can be exercised without booting a daemon. Returns
 * whether the job was cancelled.
 */
function cancelJob(store: JobStore, jobId: string, now: number): boolean {
  const job = store.get(jobId)
  if (!job) return false
  if (job.status === 'running') return false
  if (job.status === 'succeeded' || job.status === 'dead') return false
  if (job.status !== 'failed') {
    store.transition(jobId, 'failed', { exitReason: 'cancelled' })
  }
  store.transition(jobId, 'dead', { finishedAt: now })
  return true
}

describe('cancelJob', () => {
  let dir: string
  let store: JobStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-canceljob-test-'))
    store = new JobStore(join(dir, 'jobs.db'))
    store.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('cancels a pending job to dead with exitReason cancelled', () => {
    store.create(makeJob({ id: 'pend', status: 'pending' }))

    expect(cancelJob(store, 'pend', 9000)).toBe(true)

    const loaded = store.get('pend')!
    expect(loaded.status).toBe('dead')
    expect(loaded.exitReason).toBe('cancelled')
    expect(loaded.finishedAt).toBe(9000)
  })

  it('refuses to cancel a running job (left for /stop-job)', () => {
    store.create(makeJob({ id: 'run', status: 'running', sessionId: 'sess-1' }))

    expect(cancelJob(store, 'run', 9000)).toBe(false)

    const loaded = store.get('run')!
    expect(loaded.status).toBe('running') // untouched
  })

  it('cancels a retrying (failed) job straight to dead', () => {
    store.create(makeJob({ id: 'fail', status: 'failed', exitReason: 'session crashed', attempts: 1 }))

    expect(cancelJob(store, 'fail', 9000)).toBe(true)

    const loaded = store.get('fail')!
    expect(loaded.status).toBe('dead')
    expect(loaded.finishedAt).toBe(9000)
  })

  it('returns false for an unknown job id', () => {
    expect(cancelJob(store, 'nope', 9000)).toBe(false)
  })

  it('returns false for an already-terminal job', () => {
    store.create(makeJob({ id: 'done', status: 'succeeded' }))
    expect(cancelJob(store, 'done', 9000)).toBe(false)
    expect(store.get('done')!.status).toBe('succeeded')
  })
})
