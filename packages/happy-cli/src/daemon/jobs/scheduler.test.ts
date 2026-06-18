/**
 * Unit tests for the autonomous job scheduler.
 *
 * Dependency injection only — NO module mocks. Each test runs a real tmp
 * SQLite store, a real Semaphore and the real retry classifier, injecting a
 * fake `spawn` function to observe what the scheduler does on success / error /
 * containment paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from './jobStore'
import { Semaphore } from './semaphore'
import {
  JobScheduler,
  buildJobFromSubmit,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_BUDGET_USD,
  DEFAULT_TIMEOUT_MS,
} from './scheduler'
import type { SubmitJobParams, GitContainment } from './scheduler'
import type { JobRecord } from './jobTypes'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers'

/** A fake git-containment probe (ignores the directory, returns fixed facts). */
const fakeContainment = (facts: GitContainment): ((dir: string) => GitContainment) => () => facts

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

  it('captures gitHeadBefore on tick and gitHeadAfter on onSessionExit success (D-E04-7)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'happy-audit-sched-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    writeFileSync(join(repo, 'file.txt'), 'before\n')
    execFileSync('git', ['add', 'file.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo })
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

    store.create(makeJob({ id: 'audit', tier: 'supervised', directory: repo }))

    const spawn = async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-audit' })
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn })

    await scheduler.tick()
    expect(store.get('audit')!.gitHeadBefore).toBe(headBefore)

    // The job makes a commit, then its session exits successfully.
    writeFileSync(join(repo, 'file.txt'), 'after\n')
    execFileSync('git', ['add', 'file.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'job change'], { cwd: repo })
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

    scheduler.onSessionExit('sess-audit', 'success')

    const loaded = store.get('audit')!
    expect(loaded.status).toBe('succeeded')
    expect(loaded.gitHeadAfter).toBe(headAfter)
    expect(loaded.gitHeadAfter).not.toBe(loaded.gitHeadBefore)

    rmSync(repo, { recursive: true, force: true })
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

  it('defers a retried transient failure by a backoff and does not re-claim it before scheduledAt', async () => {
    store.create(makeJob({ id: 'retry', directory: dir }))

    let t = 1000
    const spawn = async (): Promise<SpawnSessionResult> => {
      throw { status: 429, message: 'rate limited' }
    }
    const scheduler = new JobScheduler({
      store,
      localSemaphore: new Semaphore(1),
      spawn,
      now: () => t,
      backoff: () => 5000,
    })

    await scheduler.tick()
    let loaded = store.get('retry')!
    expect(loaded.status).toBe('pending')
    expect(loaded.attempts).toBe(1)
    expect(loaded.scheduledAt).toBe(6000) // now(1000) + backoff(5000)

    // A tick before scheduledAt must not re-claim the deferred job.
    t = 5000
    await scheduler.tick()
    expect(store.get('retry')!.attempts).toBe(1)

    // A tick at/after scheduledAt re-claims and re-runs it (fails again → attempts 2).
    t = 7000
    await scheduler.tick()
    expect(store.get('retry')!.attempts).toBe(2)
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

  it('runs a trusted job in a linked worktree on a feature branch with no untrusted input (bypassPermissions)', async () => {
    store.create(makeJob({ id: 'trust-ok', tier: 'trusted', directory: dir }))

    const calls: SpawnSessionOptions[] = []
    const spawn = async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      calls.push(opts)
      return { type: 'success', sessionId: 'sess-trusted' }
    }
    const gitContainment = fakeContainment({ isWorktree: true, branch: 'feature/x' })
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn, gitContainment })

    await scheduler.tick()

    expect(calls).toHaveLength(1)
    expect(calls[0].environmentVariables?.HAPPY_JOB_PERMISSION_MODE).toBe('bypassPermissions')
    expect(store.get('trust-ok')!.status).toBe('running')
  })

  it('parks a trusted job NOT in a linked worktree in needs-attention (trusted-requires-worktree)', async () => {
    store.create(makeJob({ id: 'trust-noworktree', tier: 'trusted', directory: dir }))

    let spawnCount = 0
    const spawn = async (): Promise<SpawnSessionResult> => {
      spawnCount++
      return { type: 'success', sessionId: 's' }
    }
    const gitContainment = fakeContainment({ isWorktree: false, branch: 'feature/x' })
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn, gitContainment })

    await scheduler.tick()

    expect(spawnCount).toBe(0)
    const loaded = store.get('trust-noworktree')!
    expect(loaded.status).toBe('needs-attention')
    expect(loaded.exitReason).toBe('trusted-requires-worktree')
  })

  it('parks a trusted job on a protected branch (main) in needs-attention (trusted-on-protected-branch)', async () => {
    store.create(makeJob({ id: 'trust-main', tier: 'trusted', directory: dir }))

    let spawnCount = 0
    const spawn = async (): Promise<SpawnSessionResult> => {
      spawnCount++
      return { type: 'success', sessionId: 's' }
    }
    const gitContainment = fakeContainment({ isWorktree: true, branch: 'main' })
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn, gitContainment })

    await scheduler.tick()

    expect(spawnCount).toBe(0)
    const loaded = store.get('trust-main')!
    expect(loaded.status).toBe('needs-attention')
    expect(loaded.exitReason).toBe('trusted-on-protected-branch')
  })

  it('parks a trusted job on master (also protected) in needs-attention (trusted-on-protected-branch)', async () => {
    store.create(makeJob({ id: 'trust-master', tier: 'trusted', directory: dir }))

    let spawnCount = 0
    const spawn = async (): Promise<SpawnSessionResult> => {
      spawnCount++
      return { type: 'success', sessionId: 's' }
    }
    const gitContainment = fakeContainment({ isWorktree: true, branch: 'master' })
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn, gitContainment })

    await scheduler.tick()

    expect(spawnCount).toBe(0)
    expect(store.get('trust-master')!.exitReason).toBe('trusted-on-protected-branch')
  })

  it('parks a trusted job with untrustedInput in needs-attention (untrusted-requires-supervision)', async () => {
    store.create(makeJob({ id: 'trust-untrusted', tier: 'trusted', directory: dir, untrustedInput: true }))

    let spawnCount = 0
    const spawn = async (): Promise<SpawnSessionResult> => {
      spawnCount++
      return { type: 'success', sessionId: 's' }
    }
    const gitContainment = fakeContainment({ isWorktree: true, branch: 'feature/x' })
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn, gitContainment })

    await scheduler.tick()

    expect(spawnCount).toBe(0)
    const loaded = store.get('trust-untrusted')!
    expect(loaded.status).toBe('needs-attention')
    expect(loaded.exitReason).toBe('untrusted-requires-supervision')
  })

  it('does not apply the containment gate to supervised jobs (spawns regardless of git state)', async () => {
    store.create(makeJob({ id: 'sup-main', tier: 'supervised', directory: dir }))

    let containmentCalls = 0
    const calls: SpawnSessionOptions[] = []
    const spawn = async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      calls.push(opts)
      return { type: 'success', sessionId: 'sess-sup' }
    }
    const gitContainment = (): GitContainment => {
      containmentCalls++
      return { isWorktree: false, branch: 'main' }
    }
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn, gitContainment })

    await scheduler.tick()

    expect(containmentCalls).toBe(0)
    expect(calls).toHaveLength(1)
    expect(store.get('sup-main')!.status).toBe('running')
  })

  it('onSessionExit success drives a running job to succeeded', () => {
    store.create(makeJob({ id: 'ok', status: 'running', sessionId: 'sess-ok', claimedAt: 1000 }))
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn: async () => ({ type: 'success', sessionId: 's' }), now: () => 5000 })

    scheduler.onSessionExit('sess-ok', 'success')

    const loaded = store.get('ok')!
    expect(loaded.status).toBe('succeeded')
    expect(loaded.finishedAt).toBe(5000)
  })

  it('onSessionExit killed parks a running job in needs-attention', () => {
    store.create(makeJob({ id: 'kill', status: 'running', sessionId: 'sess-kill', claimedAt: 1000 }))
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn: async () => ({ type: 'success', sessionId: 's' }), now: () => 6000 })

    scheduler.onSessionExit('sess-kill', 'killed')

    const loaded = store.get('kill')!
    expect(loaded.status).toBe('needs-attention')
    expect(loaded.exitReason).toBe('killed')
    expect(loaded.finishedAt).toBe(6000)
  })

  it('onSessionExit crashed runs the retry-or-dead failure path', () => {
    store.create(makeJob({ id: 'crash', status: 'running', sessionId: 'sess-crash', attempts: 0, maxAttempts: 5, claimedAt: 1000 }))
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn: async () => ({ type: 'success', sessionId: 's' }) })

    scheduler.onSessionExit('sess-crash', 'crashed')

    const loaded = store.get('crash')!
    expect(loaded.status).toBe('pending') // requeued (transient, attempts < max)
    expect(loaded.attempts).toBe(1)
    expect(loaded.exitReason).toBe('session crashed')
  })

  it('onSessionExit ignores an unknown session and an already-terminal job', () => {
    store.create(makeJob({ id: 'done', status: 'running', sessionId: 'sess-done', claimedAt: 1000 }))
    const scheduler = new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn: async () => ({ type: 'success', sessionId: 's' }), now: () => 7000 })

    // Unknown sessionId — no-op (no throw).
    scheduler.onSessionExit('nope', 'success')

    // Drive it terminal, then a second exit must not transition again.
    scheduler.onSessionExit('sess-done', 'success')
    expect(store.get('done')!.status).toBe('succeeded')
    scheduler.onSessionExit('sess-done', 'killed')
    expect(store.get('done')!.status).toBe('succeeded')
  })

  it('enforceTimeouts kills via killOnly and drives a past-timeout job running→failed→dead (T-D)', async () => {
    store.create(makeJob({ id: 'late', status: 'running', sessionId: 'sess-late', timeoutAt: 1000, claimedAt: 500 }))

    const killedOnly: string[] = []
    const killedSession: string[] = []
    const scheduler = new JobScheduler({
      store,
      localSemaphore: new Semaphore(1),
      spawn: async () => ({ type: 'success', sessionId: 's' }),
      // killOnly signals the pid WITHOUT any state transition (the prod wiring).
      killOnly: (sid) => { killedOnly.push(sid) },
      // killSession (operator-stop path) must NOT be used on the timeout path.
      killSession: (sid) => { killedSession.push(sid) },
      now: () => 9000,
    })

    await scheduler.tick()

    expect(killedOnly).toEqual(['sess-late'])
    expect(killedSession).toEqual([])
    const loaded = store.get('late')!
    expect(loaded.status).toBe('dead')
    expect(loaded.exitReason).toBe('wall-clock-timeout')
    expect(loaded.finishedAt).toBe(9000)
  })

  it('enforceTimeouts leaves a future-timeout running job untouched', async () => {
    store.create(makeJob({ id: 'early', status: 'running', sessionId: 'sess-early', timeoutAt: 20000, claimedAt: 500 }))

    const killedOnly: string[] = []
    const scheduler = new JobScheduler({
      store,
      localSemaphore: new Semaphore(1),
      spawn: async () => ({ type: 'success', sessionId: 's' }),
      killOnly: (sid) => { killedOnly.push(sid) },
      now: () => 9000,
    })

    await scheduler.tick()

    expect(killedOnly).toEqual([])
    expect(store.get('early')!.status).toBe('running')
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

describe('JobScheduler.tierEnv local routing', () => {
  const noopSpawn = async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 's' })

  it('injects local-qwen model routing for the local-qwen preset', () => {
    const scheduler = new JobScheduler({ store: {} as JobStore, localSemaphore: new Semaphore(1), spawn: noopSpawn })
    const env = scheduler.tierEnv(makeJob({ preset: 'local-qwen', tier: 'supervised' }))
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434')
    expect(env.HAPPY_JOB_MODEL).toBe('qwen-moe')
    expect(env.ANTHROPIC_MODEL).toBe('qwen-moe')
    expect(env.HAPPY_JOB_REPORT_COST).toBeUndefined() // local jobs cost nothing
  })

  it('tolerates corrupt triggerMetadata without throwing out of tierEnv', () => {
    const scheduler = new JobScheduler({ store: {} as JobStore, localSemaphore: new Semaphore(1), spawn: noopSpawn })
    const env = scheduler.tierEnv(makeJob({ tier: 'supervised', triggerMetadata: '{not valid json' }))
    expect(env.HAPPY_JOB_ALLOWED_TOOLS).toBeUndefined()
    expect(env.HAPPY_JOB_PERMISSION_MODE).toBe('default')
  })

  it('does not inject local routing for a cloud preset', () => {
    const scheduler = new JobScheduler({ store: {} as JobStore, localSemaphore: new Semaphore(1), spawn: noopSpawn })
    const env = scheduler.tierEnv(makeJob({ preset: 'cloud-opus', tier: 'trusted' }))
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.HAPPY_JOB_MODEL).toBeUndefined()
    expect(env.HAPPY_JOB_PERMISSION_MODE).toBe('bypassPermissions')
    expect(env.HAPPY_JOB_REPORT_COST).toBe('1') // cloud jobs report their real cost
  })

  it('sets HAPPY_JOB_MAX_BUDGET_USD / HAPPY_JOB_MAX_TURNS env for a job carrying caps (T-G)', () => {
    const scheduler = new JobScheduler({ store: {} as JobStore, localSemaphore: new Semaphore(1), spawn: noopSpawn })
    const env = scheduler.tierEnv(makeJob({ tier: 'supervised', maxBudgetUsd: 5, maxTurns: 50 }))
    expect(env.HAPPY_JOB_MAX_BUDGET_USD).toBe('5')
    expect(env.HAPPY_JOB_MAX_TURNS).toBe('50')
  })

  it('sets HAPPY_JOB_ALLOWED_TOOLS for a supervised job with allowedTools metadata (T-G)', () => {
    const scheduler = new JobScheduler({ store: {} as JobStore, localSemaphore: new Semaphore(1), spawn: noopSpawn })
    const env = scheduler.tierEnv(makeJob({
      tier: 'supervised',
      triggerMetadata: JSON.stringify({ allowedTools: ['Read', 'Grep'] }),
    }))
    expect(env.HAPPY_JOB_ALLOWED_TOOLS).toBe('Read,Grep')
  })
})

describe('buildJobFromSubmit default circuit-breakers (F1)', () => {
  it('applies concrete default ceilings when the caller passes no caps (T-E)', () => {
    const params: SubmitJobParams = { directory: '/tmp/work', prompt: 'do it' }
    const now = 1000

    const job = buildJobFromSubmit(params, now, 'job-1')

    expect(job.maxTurns).toBe(DEFAULT_MAX_TURNS)
    expect(job.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD)
    expect(job.timeoutAt).toBe(now + DEFAULT_TIMEOUT_MS)
  })

  it('lets caller-provided caps override the defaults', () => {
    const params: SubmitJobParams = {
      directory: '/tmp/work',
      prompt: 'do it',
      maxTurns: 10,
      maxBudgetUsd: 1,
      timeoutMs: 60_000,
    }
    const now = 1000

    const job = buildJobFromSubmit(params, now, 'job-1')

    expect(job.maxTurns).toBe(10)
    expect(job.maxBudgetUsd).toBe(1)
    expect(job.timeoutAt).toBe(now + 60_000)
  })

  it('exposes conservative default constants', () => {
    expect(DEFAULT_MAX_TURNS).toBe(50)
    expect(DEFAULT_MAX_BUDGET_USD).toBe(5)
    expect(DEFAULT_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  it('copies untrustedInput only when defined', () => {
    const withFlag = buildJobFromSubmit({ directory: '/tmp/work', prompt: 'p', untrustedInput: true }, 1000, 'j1')
    expect(withFlag.untrustedInput).toBe(true)

    const without = buildJobFromSubmit({ directory: '/tmp/work', prompt: 'p' }, 1000, 'j2')
    expect(without.untrustedInput).toBeUndefined()
  })
})

describe('JobScheduler semaphore release on spawn-throw (T-H)', () => {
  it('releases the local permit on the spawn-throw path so the lane is not deadlocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happy-sem-throw-'))
    const store = new JobStore(join(dir, 'jobs.db'))
    store.init()
    store.create(makeJob({ id: 'throw', directory: dir }))

    const semaphore = new Semaphore(1)
    const spawn = async (): Promise<SpawnSessionResult> => {
      throw { status: 500, message: 'spawn blew up' }
    }
    const scheduler = new JobScheduler({ store, localSemaphore: semaphore, spawn })

    await scheduler.tick()

    // After a spawn that throws, the single local permit must be back.
    expect(semaphore.available).toBe(1)
    // And it must actually be re-acquirable (no leaked permit count).
    const release = await semaphore.acquire()
    expect(semaphore.available).toBe(0)
    release()

    rmSync(dir, { recursive: true, force: true })
  })
})
