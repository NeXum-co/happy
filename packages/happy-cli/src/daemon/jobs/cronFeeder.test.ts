/**
 * Tests for CronFeeder — the daemon job that turns due cron schedules into
 * pending JobRecords.
 *
 * Uses real tmp-backed CronStore + JobStore on the same db file (the production
 * layout) for realism, with an injected mutable `now` closure so minute/hour
 * boundaries are deterministic. Epoch bases are fixed UTC instants; the expected
 * occurrence values were computed offline with cron-parser (minute/hour grains
 * are TZ-independent at whole-hour boundaries).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { CronStore } from './cronStore'
import { JobStore } from './jobStore'
import { CronFeeder, buildCronJob, buildCronFromSubmit } from './cronFeeder'
import type { SubmitCronParams } from './cronFeeder'
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD, DEFAULT_TIMEOUT_MS } from './scheduler'
import type { CronSchedule } from './cronTypes'

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)        // 1767225600000
const T0_PLUS_90S = T0 + 90_000                  // first minute boundary at T0+60s
const MINUTE_BOUNDARY = T0 + 60_000              // 1767225660000
const T0_PLUS_5H = T0 + 5 * 3_600_000

function makeSchedule(overrides: Partial<CronSchedule> = {}): CronSchedule {
  return {
    id: 'sched-1',
    cronExpr: '* * * * *',
    directory: '/tmp/work',
    prompt: 'do the thing',
    tier: 'supervised',
    preset: 'local-qwen',
    enabled: true,
    createdAt: T0,
    ...overrides,
  }
}

function setup(now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'cronfeeder-'))
  const dbPath = join(dir, 'jobs.db')
  const cronStore = new CronStore(dbPath)
  const jobStore = new JobStore(dbPath)
  cronStore.init()
  jobStore.init()
  const feeder = new CronFeeder({ cronStore, jobStore, now })
  return { cronStore, jobStore, feeder }
}

describe('CronFeeder.tick', () => {
  let now: number
  const clock = () => now

  beforeEach(() => {
    now = T0
  })

  it('no catch-up on first tick: lazy-inits the watermark to now and queues nothing', () => {
    const { cronStore, jobStore, feeder } = setup(clock)
    cronStore.create(makeSchedule())

    feeder.tick()

    const cronJobs = jobStore.list().filter(j => j.triggerType === 'cron')
    expect(cronJobs).toHaveLength(0)
  })

  it('fires exactly once after a minute boundary and is idempotent on a repeat tick', () => {
    const { cronStore, jobStore, feeder } = setup(clock)
    cronStore.create(makeSchedule())

    // First tick establishes the watermark at T0 (nothing in (T0, T0]).
    feeder.tick()
    expect(jobStore.list().filter(j => j.triggerType === 'cron')).toHaveLength(0)

    // Advance past the first minute boundary.
    now = T0_PLUS_90S
    feeder.tick()

    let cronJobs = jobStore.list().filter(j => j.triggerType === 'cron')
    expect(cronJobs).toHaveLength(1)
    expect(cronJobs[0].scheduledAt).toBe(MINUTE_BOUNDARY)
    expect(cronJobs[0].triggerType).toBe('cron')

    // Same now → deterministic id + createIfAbsent → no duplicate.
    feeder.tick()
    cronJobs = jobStore.list().filter(j => j.triggerType === 'cron')
    expect(cronJobs).toHaveLength(1)
  })

  it('never queues a disabled schedule, even across a boundary tick', () => {
    const { cronStore, jobStore, feeder } = setup(clock)
    cronStore.create(makeSchedule({ enabled: false }))

    feeder.tick()
    now = T0_PLUS_90S
    feeder.tick()

    const cronJobs = jobStore.list().filter(j => j.triggerType === 'cron')
    expect(cronJobs).toHaveLength(0)
  })

  it('queues every occurrence across a long gap once the schedule is tracked (D-E04-19: no-catch-up applies only to the first-sight lazy-init, not to a tracked watermark)', () => {
    // The schedule is seen at T0 (watermark = T0). Jumping the clock 5 hours
    // forward and ticking scans (T0, T0+5h] for the hourly expression, which
    // contains 5 occurrences. These are NOT treated as "missed" because the
    // schedule was already being tracked — no-catch-up is exclusively the lazy
    // init for a freshly-seen schedule (test #1), which is why the watermark is
    // in-memory and not persisted.
    const { cronStore, jobStore, feeder } = setup(clock)
    cronStore.create(makeSchedule({ cronExpr: '0 * * * *' }))

    feeder.tick() // watermark = T0
    expect(jobStore.list().filter(j => j.triggerType === 'cron')).toHaveLength(0)

    now = T0_PLUS_5H
    feeder.tick()

    const cronJobs = jobStore.list().filter(j => j.triggerType === 'cron')
    expect(cronJobs).toHaveLength(5)
    const boundaries = cronJobs.map(j => j.scheduledAt).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(boundaries).toEqual([
      T0 + 1 * 3_600_000,
      T0 + 2 * 3_600_000,
      T0 + 3 * 3_600_000,
      T0 + 4 * 3_600_000,
      T0 + 5 * 3_600_000,
    ])
  })
})

describe('buildCronJob', () => {
  it('builds a deterministic pending cron job and includes optional caps only when present', () => {
    const occ = MINUTE_BOUNDARY
    const schedule = makeSchedule({ maxBudgetUsd: 2.5, maxTurns: 40, timeoutMs: 600_000, allowedTools: ['Read'] })

    const job = buildCronJob(schedule, occ, T0_PLUS_90S)

    expect(job.id).toBe(`cron:${schedule.id}:${occ}`)
    expect(job.triggerType).toBe('cron')
    expect(job.scheduledAt).toBe(occ)
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(0)
    expect(job.maxAttempts).toBe(5)
    expect(job.tier).toBe('supervised')
    expect(job.preset).toBe('local-qwen')
    expect(job.directory).toBe(schedule.directory)
    expect(job.prompt).toBe(schedule.prompt)
    expect(job.createdAt).toBe(T0_PLUS_90S)
    expect(JSON.parse(job.triggerMetadata)).toEqual({
      scheduleId: schedule.id,
      occurrence: occ,
      cronExpr: schedule.cronExpr,
      allowedTools: ['Read'],
    })
    expect(job.maxBudgetUsd).toBe(2.5)
    expect(job.maxTurns).toBe(40)
    expect(job.timeoutAt).toBe(T0_PLUS_90S + 600_000)
  })

  it('applies default circuit-breaker ceilings and defaults allowedTools to [] when the schedule has none (F1)', () => {
    const occ = MINUTE_BOUNDARY
    const schedule = makeSchedule()

    const job = buildCronJob(schedule, occ, T0)

    expect(job.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD)
    expect(job.maxTurns).toBe(DEFAULT_MAX_TURNS)
    expect(job.timeoutAt).toBe(T0 + DEFAULT_TIMEOUT_MS)
    expect(JSON.parse(job.triggerMetadata).allowedTools).toEqual([])
  })

  it('propagates untrustedInput from schedule to job only when set (F1)', () => {
    const occ = MINUTE_BOUNDARY

    const flagged = buildCronJob(makeSchedule({ untrustedInput: true }), occ, T0)
    expect(flagged.untrustedInput).toBe(true)

    const unflagged = buildCronJob(makeSchedule(), occ, T0)
    expect(unflagged.untrustedInput).toBeUndefined()
  })
})

describe('buildCronFromSubmit', () => {
  it('applies defaults (supervised tier, local-qwen preset, enabled) and round-trips id/createdAt', () => {
    const params: SubmitCronParams = {
      cronExpr: '*/5 * * * *',
      directory: '/tmp/work',
      prompt: 'do the thing',
    }

    const schedule = buildCronFromSubmit(params, T0, 'sched-xyz')

    expect(schedule.id).toBe('sched-xyz')
    expect(schedule.cronExpr).toBe('*/5 * * * *')
    expect(schedule.directory).toBe('/tmp/work')
    expect(schedule.prompt).toBe('do the thing')
    expect(schedule.tier).toBe('supervised')
    expect(schedule.preset).toBe('local-qwen')
    expect(schedule.enabled).toBe(true)
    expect(schedule.createdAt).toBe(T0)
    expect(schedule.maxBudgetUsd).toBeUndefined()
    expect(schedule.maxTurns).toBeUndefined()
    expect(schedule.timeoutMs).toBeUndefined()
    expect(schedule.allowedTools).toBeUndefined()
  })

  it('honours an explicit tier/preset over the defaults', () => {
    const params: SubmitCronParams = {
      cronExpr: '0 * * * *',
      directory: '/tmp/work',
      prompt: 'p',
      tier: 'trusted',
      preset: 'claude-cloud',
    }

    const schedule = buildCronFromSubmit(params, T0, 'sched-1')

    expect(schedule.tier).toBe('trusted')
    expect(schedule.preset).toBe('claude-cloud')
  })

  it('copies optional caps only when set', () => {
    const params: SubmitCronParams = {
      cronExpr: '0 * * * *',
      directory: '/tmp/work',
      prompt: 'p',
      maxBudgetUsd: 2.5,
      maxTurns: 40,
      timeoutMs: 600_000,
      allowedTools: ['Read'],
    }

    const schedule = buildCronFromSubmit(params, T0, 'sched-1')

    expect(schedule.maxBudgetUsd).toBe(2.5)
    expect(schedule.maxTurns).toBe(40)
    expect(schedule.timeoutMs).toBe(600_000)
    expect(schedule.allowedTools).toEqual(['Read'])
  })

  it('copies untrustedInput only when set (F1)', () => {
    const flagged = buildCronFromSubmit(
      { cronExpr: '0 * * * *', directory: '/tmp/work', prompt: 'p', untrustedInput: true },
      T0,
      'sched-1',
    )
    expect(flagged.untrustedInput).toBe(true)

    const unflagged = buildCronFromSubmit(
      { cronExpr: '0 * * * *', directory: '/tmp/work', prompt: 'p' },
      T0,
      'sched-2',
    )
    expect(unflagged.untrustedInput).toBeUndefined()
  })
})
