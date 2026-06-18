/**
 * Durable SQLite-backed store for cron schedules.
 *
 * Wraps a synchronous better-sqlite3 database holding one row per CronSchedule
 * in the cron_schedules table. Uses the same db file as JobStore (jobs.db) so
 * both stores share a single WAL-mode database. allowedTools is stored as a JSON
 * TEXT column (NULL when absent). SQLite has no boolean type; enabled is stored
 * as INTEGER 0/1 and converted back to a real boolean on read.
 */

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '@/ui/logger'
import type { CronSchedule } from './cronTypes'

interface CronRow {
  id: string
  cronExpr: string
  directory: string
  prompt: string
  tier: string
  preset: string
  untrustedInput: number | null
  maxBudgetUsd: number | null
  maxTurns: number | null
  timeoutMs: number | null
  allowedTools: string | null
  enabled: number
  createdAt: number
}

function rowToSchedule(row: CronRow): CronSchedule {
  const schedule: CronSchedule = {
    id: row.id,
    cronExpr: row.cronExpr,
    directory: row.directory,
    prompt: row.prompt,
    tier: row.tier as CronSchedule['tier'],
    preset: row.preset,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
  }
  if (row.untrustedInput !== null) schedule.untrustedInput = row.untrustedInput === 1
  if (row.maxBudgetUsd !== null) schedule.maxBudgetUsd = row.maxBudgetUsd
  if (row.maxTurns !== null) schedule.maxTurns = row.maxTurns
  if (row.timeoutMs !== null) schedule.timeoutMs = row.timeoutMs
  if (row.allowedTools !== null) schedule.allowedTools = parseAllowedTools(row.allowedTools, row.id)
  return schedule
}

/**
 * Parse the allowedTools JSON column, tolerating a corrupt row (F6). A single
 * malformed value must not throw out of list() — that would abort the cron
 * feeder's whole tick, skipping every schedule. Degrade to no allowlist with a
 * logged warning, mirroring the scheduler's parseTriggerMetadata.
 */
function parseAllowedTools(raw: string, id: string): string[] {
  try {
    return JSON.parse(raw) as string[]
  } catch (error) {
    logger.warn(`[CRON STORE] corrupt allowedTools for schedule ${id}, treating as empty:`, error)
    return []
  }
}

export class CronStore {
  private readonly db: Database.Database

  constructor(dbPath: string = join(homedir(), '.happy', 'jobs.db')) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_schedules (
        id TEXT PRIMARY KEY,
        cronExpr TEXT NOT NULL,
        directory TEXT NOT NULL,
        prompt TEXT NOT NULL,
        tier TEXT NOT NULL,
        preset TEXT NOT NULL,
        untrustedInput INTEGER,
        maxBudgetUsd REAL,
        maxTurns INTEGER,
        timeoutMs INTEGER,
        allowedTools TEXT,
        enabled INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `)
    // Idempotent migration: add untrustedInput to a store created before it existed.
    const cols = this.db.prepare(`PRAGMA table_info(cron_schedules)`).all() as { name: string }[]
    if (!cols.some(c => c.name === 'untrustedInput')) {
      this.db.exec(`ALTER TABLE cron_schedules ADD COLUMN untrustedInput INTEGER`)
    }
    // Index the feeder's scan path: each tick lists schedules and skips disabled ones.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_schedules_enabled ON cron_schedules (enabled)`)
  }

  create(s: CronSchedule): void {
    this.db.prepare(`
      INSERT INTO cron_schedules (
        id, cronExpr, directory, prompt, tier, preset, untrustedInput,
        maxBudgetUsd, maxTurns, timeoutMs, allowedTools, enabled, createdAt
      ) VALUES (
        @id, @cronExpr, @directory, @prompt, @tier, @preset, @untrustedInput,
        @maxBudgetUsd, @maxTurns, @timeoutMs, @allowedTools, @enabled, @createdAt
      )
    `).run({
      id: s.id,
      cronExpr: s.cronExpr,
      directory: s.directory,
      prompt: s.prompt,
      tier: s.tier,
      preset: s.preset,
      untrustedInput: s.untrustedInput === undefined ? null : (s.untrustedInput ? 1 : 0),
      maxBudgetUsd: s.maxBudgetUsd ?? null,
      maxTurns: s.maxTurns ?? null,
      timeoutMs: s.timeoutMs ?? null,
      allowedTools: s.allowedTools !== undefined ? JSON.stringify(s.allowedTools) : null,
      enabled: s.enabled ? 1 : 0,
      createdAt: s.createdAt,
    })
  }

  get(id: string): CronSchedule | undefined {
    const row = this.db.prepare('SELECT * FROM cron_schedules WHERE id = ?').get(id) as CronRow | undefined
    return row ? rowToSchedule(row) : undefined
  }

  list(): CronSchedule[] {
    const rows = this.db.prepare('SELECT * FROM cron_schedules ORDER BY createdAt ASC').all() as CronRow[]
    return rows.map(rowToSchedule)
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM cron_schedules WHERE id = ?').run(id)
    return result.changes === 1
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE cron_schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  /** Close the underlying SQLite connection (daemon shutdown, ARCH-5). */
  close(): void {
    this.db.close()
  }
}
