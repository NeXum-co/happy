/**
 * CronFeeder — the daemon job that turns due cron schedules into pending
 * JobRecords.
 *
 * On each tick it scans every enabled schedule's fire times in the half-open
 * interval (watermark, now] and inserts one idempotent JobRecord per occurrence.
 * Dedupe is structural: the job id is `cron:{scheduleId}:{occurrenceMs}`, so a
 * repeated tick over the same window is a no-op via JobStore.createIfAbsent.
 *
 * The watermark map (`scannedThrough`) is INTENTIONALLY in-memory and not
 * persisted. A schedule the feeder sees for the first time — at daemon startup
 * or right after it was created — is lazy-initialised to `now`, so it is watched
 * from this moment forward rather than from createdAt. Persisting the watermark
 * would let the feeder "catch up" on every fire time that elapsed while the
 * daemon was down, reintroducing exactly the missed-run backlog D-E04-19 forbids.
 * Forgetting the watermark on restart is the mechanism, not a bug.
 *
 * cronStore/jobStore are synchronous (better-sqlite3), so tick() is synchronous.
 * The interval loop guards against overlapping ticks and swallows + logs any
 * throw so a single bad tick can never bring the daemon down (mirrors
 * JobScheduler.start).
 */

import { logger } from '@/ui/logger'
import { occurrencesBetween } from './cronSchedule'
import type { CronStore } from './cronStore'
import type { JobStore } from './jobStore'
import type { CronSchedule } from './cronTypes'
import type { JobRecord } from './jobTypes'

interface CronFeederDeps {
  cronStore: CronStore
  jobStore: JobStore
  intervalMs?: number
  now?: () => number
  newId?: (scheduleId: string, occurrenceMs: number) => string
}

/**
 * Pure mapping from a schedule + occurrence to a fresh pending cron JobRecord.
 * The id is deterministic so repeated ticks dedupe through createIfAbsent.
 * Optional caps are copied only when the schedule sets them; the schedule's
 * timeoutMs becomes an absolute timeoutAt relative to `now`.
 */
export function buildCronJob(schedule: CronSchedule, occurrenceMs: number, now: number): JobRecord {
  const job: JobRecord = {
    id: `cron:${schedule.id}:${occurrenceMs}`,
    triggerType: 'cron',
    triggerMetadata: JSON.stringify({
      scheduleId: schedule.id,
      occurrence: occurrenceMs,
      cronExpr: schedule.cronExpr,
      allowedTools: schedule.allowedTools ?? [],
    }),
    tier: schedule.tier,
    preset: schedule.preset,
    directory: schedule.directory,
    prompt: schedule.prompt,
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    scheduledAt: occurrenceMs,
    createdAt: now,
  }
  if (schedule.maxBudgetUsd !== undefined) job.maxBudgetUsd = schedule.maxBudgetUsd
  if (schedule.maxTurns !== undefined) job.maxTurns = schedule.maxTurns
  if (schedule.timeoutMs !== undefined) job.timeoutAt = now + schedule.timeoutMs
  return job
}

export class CronFeeder {
  private readonly cronStore: CronStore
  private readonly jobStore: JobStore
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly newId?: (scheduleId: string, occurrenceMs: number) => string
  private timer: NodeJS.Timeout | null = null
  private running = false
  private scannedThrough = new Map<string, number>()

  constructor(deps: CronFeederDeps) {
    this.cronStore = deps.cronStore
    this.jobStore = deps.jobStore
    this.intervalMs = deps.intervalMs ?? 1000
    this.now = deps.now ?? Date.now
    this.newId = deps.newId
  }

  tick(): void {
    const now = this.now()
    const schedules = this.cronStore.list()
    const seen = new Set<string>()

    for (const s of schedules) {
      seen.add(s.id)
      if (s.enabled === false) continue

      // Lazy-init: a schedule seen for the first time is watched from now, never
      // from createdAt. This is the no-catch-up mechanism (D-E04-19).
      const last = this.scannedThrough.get(s.id) ?? now
      const occ = occurrencesBetween(s.cronExpr, last, now)
      for (const o of occ) {
        const job = buildCronJob(s, o, now)
        if (this.newId) job.id = this.newId(s.id, o)
        this.jobStore.createIfAbsent(job)
      }
      this.scannedThrough.set(s.id, now)
    }

    // Drop watermarks for schedules that no longer exist so the map cannot grow
    // unbounded across deletions.
    for (const id of this.scannedThrough.keys()) {
      if (!seen.has(id)) this.scannedThrough.delete(id)
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.running) return
      this.running = true
      try {
        // A throw inside a tick (e.g. an unexpected store error) must not bring
        // the daemon down for one bad tick. Log and continue (mirrors
        // JobScheduler.start).
        this.tick()
      } catch (error) {
        logger.debug('[CRON FEEDER] tick failed, continuing:', error)
      } finally {
        this.running = false
      }
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
