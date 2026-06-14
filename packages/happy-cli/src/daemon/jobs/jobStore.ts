/**
 * Durable SQLite-backed store for autonomous jobs.
 *
 * Wraps a synchronous better-sqlite3 database holding one row per JobRecord.
 * claimNext runs inside a transaction so a single pending job is handed to
 * exactly one worker (the transaction is the fence). recoverOnStartup re-queues
 * running jobs whose timeout passed while the daemon was down, without touching
 * their attempt count. Optional JobRecord fields map to nullable columns and
 * round-trip back to `undefined`.
 */

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertTransition } from './stateMachine'
import type { JobRecord, JobStatus } from './jobTypes'

interface JobRow {
  id: string
  triggerType: string
  triggerMetadata: string
  tier: string
  preset: string
  directory: string
  prompt: string
  status: string
  attempts: number
  maxAttempts: number
  sessionId: string | null
  scheduledAt: number | null
  claimedAt: number | null
  timeoutAt: number | null
  finishedAt: number | null
  exitReason: string | null
  costUsd: number | null
  maxBudgetUsd: number | null
  maxTurns: number | null
  createdAt: number
}

function rowToRecord(row: JobRow): JobRecord {
  const record: JobRecord = {
    id: row.id,
    triggerType: row.triggerType as JobRecord['triggerType'],
    triggerMetadata: row.triggerMetadata,
    tier: row.tier as JobRecord['tier'],
    preset: row.preset,
    directory: row.directory,
    prompt: row.prompt,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt,
  }
  if (row.sessionId !== null) record.sessionId = row.sessionId
  if (row.scheduledAt !== null) record.scheduledAt = row.scheduledAt
  if (row.claimedAt !== null) record.claimedAt = row.claimedAt
  if (row.timeoutAt !== null) record.timeoutAt = row.timeoutAt
  if (row.finishedAt !== null) record.finishedAt = row.finishedAt
  if (row.exitReason !== null) record.exitReason = row.exitReason
  if (row.costUsd !== null) record.costUsd = row.costUsd
  if (row.maxBudgetUsd !== null) record.maxBudgetUsd = row.maxBudgetUsd
  if (row.maxTurns !== null) record.maxTurns = row.maxTurns
  return record
}

export class JobStore {
  private readonly db: Database.Database

  constructor(dbPath: string = join(homedir(), '.happy', 'jobs.db')) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        triggerType TEXT NOT NULL,
        triggerMetadata TEXT NOT NULL,
        tier TEXT NOT NULL,
        preset TEXT NOT NULL,
        directory TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        maxAttempts INTEGER NOT NULL,
        sessionId TEXT,
        scheduledAt INTEGER,
        claimedAt INTEGER,
        timeoutAt INTEGER,
        finishedAt INTEGER,
        exitReason TEXT,
        costUsd REAL,
        maxBudgetUsd REAL,
        maxTurns INTEGER,
        createdAt INTEGER NOT NULL
      )
    `)
  }

  create(job: JobRecord): void {
    this.db.prepare(`
      INSERT INTO jobs (
        id, triggerType, triggerMetadata, tier, preset, directory, prompt,
        status, attempts, maxAttempts, sessionId, scheduledAt, claimedAt,
        timeoutAt, finishedAt, exitReason, costUsd, maxBudgetUsd, maxTurns, createdAt
      ) VALUES (
        @id, @triggerType, @triggerMetadata, @tier, @preset, @directory, @prompt,
        @status, @attempts, @maxAttempts, @sessionId, @scheduledAt, @claimedAt,
        @timeoutAt, @finishedAt, @exitReason, @costUsd, @maxBudgetUsd, @maxTurns, @createdAt
      )
    `).run({
      id: job.id,
      triggerType: job.triggerType,
      triggerMetadata: job.triggerMetadata,
      tier: job.tier,
      preset: job.preset,
      directory: job.directory,
      prompt: job.prompt,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      sessionId: job.sessionId ?? null,
      scheduledAt: job.scheduledAt ?? null,
      claimedAt: job.claimedAt ?? null,
      timeoutAt: job.timeoutAt ?? null,
      finishedAt: job.finishedAt ?? null,
      exitReason: job.exitReason ?? null,
      costUsd: job.costUsd ?? null,
      maxBudgetUsd: job.maxBudgetUsd ?? null,
      maxTurns: job.maxTurns ?? null,
      createdAt: job.createdAt,
    })
  }

  get(id: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  list(filter?: { status?: JobStatus }): JobRecord[] {
    const rows = filter?.status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY createdAt ASC').all(filter.status) as JobRow[]
      : this.db.prepare('SELECT * FROM jobs ORDER BY createdAt ASC').all() as JobRow[]
    return rows.map(rowToRecord)
  }

  transition(id: string, to: JobStatus, patch?: Partial<JobRecord>): void {
    const current = this.get(id)
    if (!current) throw new Error(`Job ${id} not found`)
    assertTransition(current.status, to)
    this.applyUpdate(id, { ...patch, status: to })
  }

  claimNext(now: number = Date.now()): JobRecord | undefined {
    const claim = this.db.transaction((ts: number): JobRecord | undefined => {
      const row = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status = 'pending' AND (scheduledAt IS NULL OR scheduledAt <= ?)
        ORDER BY createdAt ASC
        LIMIT 1
      `).get(ts) as JobRow | undefined
      if (!row) return undefined
      assertTransition(row.status as JobStatus, 'running')
      this.applyUpdate(row.id, { status: 'running', claimedAt: ts })
      return this.get(row.id)
    })
    return claim(now)
  }

  recoverOnStartup(now: number = Date.now()): number {
    const result = this.db.prepare(`
      UPDATE jobs SET status = 'pending'
      WHERE status = 'running' AND timeoutAt IS NOT NULL AND timeoutAt < ?
    `).run(now)
    return result.changes
  }

  /**
   * Update arbitrary fields WITHOUT a status transition. Use for changes that
   * keep the job in its current status (e.g. attaching a sessionId to an
   * already-running job — running -> running is not a legal state edge).
   */
  patch(id: string, partial: Partial<JobRecord>): void {
    this.applyUpdate(id, partial)
  }

  private applyUpdate(id: string, patch: Partial<JobRecord>): void {
    const columns: (keyof JobRecord)[] = [
      'triggerType', 'triggerMetadata', 'tier', 'preset', 'directory', 'prompt',
      'status', 'attempts', 'maxAttempts', 'sessionId', 'scheduledAt', 'claimedAt',
      'timeoutAt', 'finishedAt', 'exitReason', 'costUsd', 'maxBudgetUsd', 'maxTurns', 'createdAt',
    ]
    const present = columns.filter(c => c in patch)
    if (present.length === 0) return
    const assignments = present.map(c => `${c} = @${c}`).join(', ')
    const params: Record<string, unknown> = { id }
    for (const c of present) params[c] = patch[c] ?? null
    this.db.prepare(`UPDATE jobs SET ${assignments} WHERE id = @id`).run(params)
  }
}
