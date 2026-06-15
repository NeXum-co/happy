/**
 * AC-7 integration test for the cron spine (slice 2).
 *
 * This wires the SAME object graph the daemon builds in run.ts — a CronStore and
 * a JobStore over ONE real SQLite file, a CronFeeder over both, and a real
 * JobScheduler with an injected fake spawn — and exercises the full path a cron
 * schedule travels: submit (validate + buildCronFromSubmit + cronStore.create) →
 * feeder turns a due occurrence into a pending triggerType:'cron' JobRecord →
 * scheduler claims and runs it. No relay, no auth, no module mocks: just the real
 * compiled modules over real persistence with one injected clock.
 *
 * AC-7 (D-E04-19):
 *  (a) a running daemon fires a schedule on its boundary, exactly once per
 *      occurrence (no double), and the scheduler claims the resulting job.
 *  (b) a missed run during downtime is NOT caught up: a fresh feeder (the
 *      in-memory watermark is forgotten on restart) lazy-inits to now, so its
 *      first tick after a long gap enqueues nothing for the elapsed period.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronStore } from './cronStore'
import { JobStore } from './jobStore'
import { CronFeeder, buildCronFromSubmit } from './cronFeeder'
import { JobScheduler } from './scheduler'
import { Semaphore } from './semaphore'
import { validateCronExpr } from './cronSchedule'
import type { CronSchedule } from './cronTypes'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers'

// A fixed UTC base on a minute boundary so occurrence math is deterministic
// regardless of the host timezone.
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0) // 2026-01-01T00:00:00Z

// Mirror of run.ts's submitCron closure: validate then persist an enabled schedule.
function submitCron(cronStore: CronStore, params: { cronExpr: string; directory: string; prompt: string }, now: number): string {
  if (!validateCronExpr(params.cronExpr)) throw new Error('invalid cronExpr')
  const schedule: CronSchedule = buildCronFromSubmit(params, now, `sched-${now}`)
  cronStore.create(schedule)
  return schedule.id
}

describe('cron spine integration (AC-7)', () => {
  let dir: string
  let cronStore: CronStore
  let jobStore: JobStore
  let clock: number
  const now = () => clock

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-cron-integ-'))
    const dbPath = join(dir, 'jobs.db')
    // The daemon shares one jobs.db between both stores (WAL). Mirror that.
    jobStore = new JobStore(dbPath)
    jobStore.init()
    cronStore = new CronStore(dbPath)
    cronStore.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('(a) fires once on the boundary and the scheduler claims the cron job; a repeat tick does not double', async () => {
    clock = T0
    const scheduleId = submitCron(cronStore, { cronExpr: '* * * * *', directory: dir, prompt: 'do the cron thing' }, clock)

    const feeder = new CronFeeder({ cronStore, jobStore, now })

    // First tick at T0: lazy-init watermark to T0, window (T0, T0] is empty.
    feeder.tick()
    expect(jobStore.list().filter(j => j.triggerType === 'cron')).toHaveLength(0)

    // Advance 90s past one minute boundary (T0 + 60s) and tick: exactly one job.
    clock = T0 + 90_000
    feeder.tick()
    const cronJobs = jobStore.list().filter(j => j.triggerType === 'cron')
    expect(cronJobs).toHaveLength(1)
    const job = cronJobs[0]
    expect(job.id).toBe(`cron:${scheduleId}:${T0 + 60_000}`)
    expect(job.scheduledAt).toBe(T0 + 60_000)
    expect(job.status).toBe('pending')

    // A repeat tick at the same now must not create a second job (deterministic
    // id + createIfAbsent dedupe).
    feeder.tick()
    expect(jobStore.list().filter(j => j.triggerType === 'cron')).toHaveLength(1)

    // The scheduler claims and runs the cron job exactly like a manual one.
    // This AC-7 cron schedule carries no dispositionTopic, so the E05 pre-spawn
    // gate would fail-closed and park it; mark it gateResolved to exercise the
    // cron→claim+run path here (the gate itself is tested in scheduler.test.ts).
    jobStore.patch(job.id, { gateResolved: true })
    const calls: SpawnSessionOptions[] = []
    const spawn = async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      calls.push(opts)
      return { type: 'success', sessionId: 'sess-cron' }
    }
    const scheduler = new JobScheduler({ store: jobStore, localSemaphore: new Semaphore(1), spawn, now })
    await scheduler.tick()

    expect(calls).toHaveLength(1)
    expect(calls[0].initialPrompt).toBe('do the cron thing')
    const claimed = jobStore.get(job.id)!
    expect(claimed.status).toBe('running')
    expect(claimed.sessionId).toBe('sess-cron')
  })

  it('(b) no missed-run catch-up: a fresh feeder after a long gap enqueues nothing for the elapsed period', () => {
    // A schedule created long ago. The daemon was "down" across many of its
    // occurrences; on restart the in-memory watermark is gone.
    clock = T0
    submitCron(cronStore, { cronExpr: '0 * * * *', directory: dir, prompt: 'hourly' }, clock)

    // Simulate restart: a brand-new feeder (empty scannedThrough) at T0 + 5h.
    const fresh = new CronFeeder({ cronStore, jobStore, now })
    clock = T0 + 5 * 3_600_000
    fresh.tick()

    // Lazy-init to now → window (now, now] empty → zero catch-up jobs for the gap.
    expect(jobStore.list().filter(j => j.triggerType === 'cron')).toHaveLength(0)

    // It resumes normally: a tick after the next real boundary fires exactly one.
    clock = T0 + 5 * 3_600_000 + 3_600_000 + 1
    fresh.tick()
    expect(jobStore.list().filter(j => j.triggerType === 'cron')).toHaveLength(1)
  })
})
