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
import { DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD, DEFAULT_TIMEOUT_MS } from './scheduler'
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
 * The default circuit-breakers (D-E04-6) apply when the schedule sets no cap, so
 * every cron job gets a concrete budget/turn/wall-clock ceiling; a schedule value
 * overrides the default. `untrustedInput` is forwarded only when set.
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
    maxBudgetUsd: schedule.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
    maxTurns: schedule.maxTurns ?? DEFAULT_MAX_TURNS,
    timeoutAt: now + (schedule.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    createdAt: now,
  }
  // maxBudgetUsd/maxTurns/timeoutAt already carry the F1 defaults from the literal.
  if (schedule.untrustedInput !== undefined) job.untrustedInput = schedule.untrustedInput
  if (schedule.dispositionTopic !== undefined) job.dispositionTopic = schedule.dispositionTopic
  if (schedule.account !== undefined) job.account = schedule.account
  return job
}

/** Params accepted by the submit-cron RPC / HTTP endpoint (cron schedules, E04). */
export interface SubmitCronParams {
  cronExpr: string
  directory: string
  prompt: string
  tier?: 'trusted' | 'supervised'
  preset?: string
  untrustedInput?: boolean
  maxBudgetUsd?: number
  maxTurns?: number
  timeoutMs?: number
  allowedTools?: string[]
  dispositionTopic?: string
  account?: string
}

/**
 * Pure mapping from submit-cron params to a fresh enabled CronSchedule.
 * Defaults: supervised tier, 'local-qwen' preset, enabled. Optional caps are
 * copied only when set. Mirrors buildJobFromSubmit.
 */
export function buildCronFromSubmit(params: SubmitCronParams, now: number, id: string): CronSchedule {
  const schedule: CronSchedule = {
    id,
    cronExpr: params.cronExpr,
    directory: params.directory,
    prompt: params.prompt,
    tier: params.tier ?? 'supervised',
    preset: params.preset ?? 'local-qwen',
    enabled: true,
    createdAt: now,
  }
  if (params.untrustedInput !== undefined) schedule.untrustedInput = params.untrustedInput
  if (params.maxBudgetUsd !== undefined) schedule.maxBudgetUsd = params.maxBudgetUsd
  if (params.maxTurns !== undefined) schedule.maxTurns = params.maxTurns
  if (params.timeoutMs !== undefined) schedule.timeoutMs = params.timeoutMs
  if (params.allowedTools !== undefined) schedule.allowedTools = params.allowedTools
  if (params.dispositionTopic !== undefined) schedule.dispositionTopic = params.dispositionTopic
  if (params.account !== undefined) schedule.account = params.account
  return schedule
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

      // Per-schedule try/catch so one bad schedule (e.g. an unparseable expr or a
      // store error for a single occurrence) is skipped with its id logged,
      // rather than aborting the rest of the tick (SF-4). The watermark still
      // advances on failure so a persistently-broken schedule isn't retried
      // every tick over an ever-growing window.
      try {
        // Lazy-init: a schedule seen for the first time is watched from now, never
        // from createdAt. This is the no-catch-up mechanism (D-E04-19).
        const last = this.scannedThrough.get(s.id) ?? now
        const occ = occurrencesBetween(s.cronExpr, last, now)
        for (const o of occ) {
          const job = buildCronJob(s, o, now)
          if (this.newId) job.id = this.newId(s.id, o)
          this.jobStore.createIfAbsent(job)
        }
      } catch (error) {
        logger.warn(`[CRON FEEDER] schedule ${s.id} (${s.cronExpr}) failed this tick, skipping:`, error)
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
