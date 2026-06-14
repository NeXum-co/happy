/**
 * Unit tests for the autonomous job scheduler.
 *
 * Dependency injection only — NO module mocks. Each test runs a real tmp
 * SQLite store, a real Semaphore and the real retry classifier, injecting a
 * fake `spawn` function to observe what the scheduler does on success / error /
 * containment paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from './jobStore'
import { Semaphore } from './semaphore'
import { JobScheduler } from './scheduler'
import type { JobRecord } from './jobTypes'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers'

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

describe('JobScheduler', () => {
  let dir: string
  let store: JobStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-scheduler-test-'))
    store = new JobStore(join(dir, 'jobs.db'))
    store.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs a supervised pending job and attaches the sessionId', async () => {
    store.create(makeJob({ id: 'sup', tier: 'supervised', directory: dir }))

    const calls: SpawnSessionOptions[] = []
    const spawn = async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      calls.push(opts)
      return { type: 'success', sessionId: 'sess-xyz' }
    }
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn })

    await scheduler.tick()

    expect(calls).toHaveLength(1)
    expect(calls[0].environmentVariables?.HAPPY_JOB_PERMISSION_MODE).toBe('default')
    expect(calls[0].initialPrompt).toBe('do the thing')

    const loaded = store.get('sup')!
    expect(loaded.sessionId).toBe('sess-xyz')
    expect(loaded.status).toBe('running')
  })

  it('re-queues a transient (429) failure as pending with incremented attempts', async () => {
    store.create(makeJob({ id: 'trans', directory: dir }))

    const spawn = async (): Promise<SpawnSessionResult> => {
      throw { status: 429, message: 'rate limited' }
    }
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn })

    await scheduler.tick()

    const loaded = store.get('trans')!
    expect(loaded.status).toBe('pending')
    expect(loaded.attempts).toBe(1)
  })

  it('marks a permanent (400) failure as dead', async () => {
    store.create(makeJob({ id: 'perm', directory: dir }))

    const spawn = async (): Promise<SpawnSessionResult> => {
      throw { status: 400, message: 'bad request' }
    }
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn })

    await scheduler.tick()

    const loaded = store.get('perm')!
    expect(loaded.status).toBe('dead')
    expect(loaded.attempts).toBe(1)
  })

  it('parks a trusted job without a .git directory in needs-attention, never spawning', async () => {
    const noGit = mkdtempSync(join(tmpdir(), 'happy-nogit-'))
    store.create(makeJob({ id: 'trust-nogit', tier: 'trusted', directory: noGit }))

    let spawnCount = 0
    const spawn = async (): Promise<SpawnSessionResult> => {
      spawnCount++
      return { type: 'success', sessionId: 's' }
    }
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn })

    await scheduler.tick()

    expect(spawnCount).toBe(0)
    const loaded = store.get('trust-nogit')!
    expect(loaded.status).toBe('needs-attention')
    expect(loaded.exitReason).toBe('trusted-requires-worktree')

    rmSync(noGit, { recursive: true, force: true })
  })

  it('runs a trusted job inside a git worktree with bypassPermissions', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'happy-worktree-'))
    mkdirSync(join(worktree, '.git'))
    store.create(makeJob({ id: 'trust-git', tier: 'trusted', directory: worktree }))

    const calls: SpawnSessionOptions[] = []
    const spawn = async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      calls.push(opts)
      return { type: 'success', sessionId: 'sess-trusted' }
    }
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn })

    await scheduler.tick()

    expect(calls).toHaveLength(1)
    expect(calls[0].environmentVariables?.HAPPY_JOB_PERMISSION_MODE).toBe('bypassPermissions')
    expect(store.get('trust-git')!.status).toBe('running')

    rmSync(worktree, { recursive: true, force: true })
  })

  it('serializes local jobs through a Semaphore(1)', async () => {
    store.create(makeJob({ id: 'a', createdAt: 1000, directory: dir }))
    store.create(makeJob({ id: 'b', createdAt: 2000, directory: dir }))

    let inFlight = 0
    let maxInFlight = 0
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })

    const spawn = async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (opts.sessionName === 'job-a') {
        await firstBlocked
      }
      inFlight--
      return { type: 'success', sessionId: opts.sessionName! }
    }

    const semaphore = new Semaphore(1)
    const scheduler = new JobScheduler({ store, localSemaphore: semaphore, spawn })

    const firstTick = scheduler.tick()
    const secondTick = scheduler.tick()

    // The second tick cannot acquire the single permit while the first holds it.
    await new Promise((r) => setTimeout(r, 20))
    expect(maxInFlight).toBe(1)
    expect(semaphore.available).toBe(0)

    releaseFirst()
    await Promise.all([firstTick, secondTick])

    expect(maxInFlight).toBe(1)
    expect(store.get('a')!.sessionId).toBe('job-a')
    expect(store.get('b')!.sessionId).toBe('job-b')
  })
})
