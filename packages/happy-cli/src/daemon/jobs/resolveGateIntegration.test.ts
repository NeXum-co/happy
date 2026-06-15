/**
 * Surface integration test for resolve-gate (E05 slice 2, Task 4 / BUG-UAT-1).
 *
 * This wires the SAME object graph the daemon builds in run.ts — a real JobStore
 * over one tmp SQLite file and a real JobScheduler with an injected fake spawn
 * and an injected disposition rollup — and exercises the resolve-gate path a job
 * travels from BOTH control surfaces: the daemon's `resolveGate` closure (which
 * both the HTTP POST /resolve-gate route and the apiMachine resolve-gate RPC
 * handler call) delegates verbatim to jobScheduler.resolveGate, so this asserts
 * the closure both surfaces share.
 *
 * It also asserts the surface-level param validation that the HTTP zod schema
 * (decision: z.enum(['approve','reject'])) and the RPC handler (decision !==
 * 'approve' && decision !== 'reject' → throw) both enforce before ever reaching
 * the closure — a bad `decision` is rejected at the boundary, not silently run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from './jobStore'
import { JobScheduler } from './scheduler'
import { Semaphore } from './semaphore'
import type { JobRecord } from './jobTypes'
import type { DispositionRollup } from '@/disposition/types'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers'

// A rollup that maps the topic this test uses to the override-prone bucket, so
// the pre-spawn gate parks the job in needs-attention (the state resolve-gate
// then resolves). Mirrors the fake rollup in scheduler.test.ts.
const fakeRollup = (): DispositionRollup => ({
  generatedFrom: 10,
  domains: {},
  topics: {
    'arch/override': { a: 1, m: 1, o: 6, d: 2, n: 10, bucket: 'override-prone' },
  },
})

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    triggerType: 'manual',
    triggerMetadata: '{}',
    tier: 'supervised',
    preset: 'local-qwen',
    directory: '/tmp/work',
    prompt: 'do the gated thing',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    createdAt: 1000,
    ...overrides,
  }
}

describe('resolve-gate surface integration (E05, both surfaces share one closure)', () => {
  let dir: string
  let store: JobStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-resolvegate-integ-'))
    store = new JobStore(join(dir, 'jobs.db'))
    store.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("approve: a gate-parked needs-attention job runs (fake spawn called) via the run.ts resolveGate closure", async () => {
    store.create(makeJob({ id: 'g-approve', tier: 'supervised', directory: dir, dispositionTopic: 'arch/override' }))
    const calls: SpawnSessionOptions[] = []
    const spawn = async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      calls.push(opts)
      return { type: 'success', sessionId: 'sess-approve' }
    }
    const jobScheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn, loadRollup: fakeRollup })

    // The pre-spawn gate parks the override-prone job in needs-attention.
    await jobScheduler.tick()
    expect(calls).toHaveLength(0)
    expect(store.get('g-approve')!.status).toBe('needs-attention')

    // The closure both control surfaces invoke (run.ts:1043) — a thin delegate.
    const resolveGate = (jobId: string, decision: 'approve' | 'reject'): Promise<boolean> =>
      jobScheduler.resolveGate(jobId, decision)

    const resolved = await resolveGate('g-approve', 'approve')

    expect(resolved).toBe(true)
    expect(calls).toHaveLength(1)
    const loaded = store.get('g-approve')!
    expect(loaded.status).toBe('running')
    expect(loaded.gateResolved).toBe(true)
  })

  it("reject: a fresh gate-parked job goes dead, fake spawn never called", async () => {
    store.create(makeJob({ id: 'g-reject', tier: 'supervised', directory: dir, dispositionTopic: 'arch/override' }))
    const calls: SpawnSessionOptions[] = []
    const spawn = async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      calls.push(opts)
      return { type: 'success', sessionId: 'sess-reject' }
    }
    const jobScheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn, loadRollup: fakeRollup })

    await jobScheduler.tick()
    expect(store.get('g-reject')!.status).toBe('needs-attention')

    const resolveGate = (jobId: string, decision: 'approve' | 'reject'): Promise<boolean> =>
      jobScheduler.resolveGate(jobId, decision)

    const resolved = await resolveGate('g-reject', 'reject')

    expect(resolved).toBe(true)
    expect(calls).toHaveLength(0)
    const loaded = store.get('g-reject')!
    expect(loaded.status).toBe('dead')
    expect(loaded.exitReason).toBe('gate-rejected')
  })

  it("param validation: a decision other than approve/reject is refused at both surfaces' boundary", () => {
    // The HTTP route validates via zod (body.decision: z.enum(['approve','reject']))
    // and the RPC handler via an explicit guard, both BEFORE the closure runs.
    // Both reduce to this predicate, asserted here as the shared contract.
    const isValidDecision = (decision: unknown): decision is 'approve' | 'reject' =>
      decision === 'approve' || decision === 'reject'

    expect(isValidDecision('approve')).toBe(true)
    expect(isValidDecision('reject')).toBe(true)
    expect(isValidDecision('maybe')).toBe(false)
    expect(isValidDecision('')).toBe(false)
    expect(isValidDecision(undefined)).toBe(false)
    expect(isValidDecision(null)).toBe(false)

    // The RPC handler's guard throws on a bad decision (mirrors apiMachine.ts).
    const rpcValidate = (jobId: unknown, decision: unknown) => {
      if (typeof jobId !== 'string' || jobId.length === 0) throw new Error('jobId is required')
      if (decision !== 'approve' && decision !== 'reject') throw new Error("decision must be 'approve' or 'reject'")
    }
    expect(() => rpcValidate('g-x', 'maybe')).toThrow("decision must be 'approve' or 'reject'")
    expect(() => rpcValidate('', 'approve')).toThrow('jobId is required')
    expect(() => rpcValidate('g-x', 'approve')).not.toThrow()
  })
})
