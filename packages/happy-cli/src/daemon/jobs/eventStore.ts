/**
 * Durable SQLite-backed store for event subscriptions.
 *
 * Wraps a synchronous better-sqlite3 database holding one row per
 * EventSubscription in the event_subscriptions table. Uses the same db file as
 * JobStore (jobs.db) so both stores share a single WAL-mode database.
 * allowedTools is stored as a JSON TEXT column (NULL when absent). matchKey is a
 * nullable TEXT column (NULL when absent). SQLite has no boolean type; enabled is
 * stored as INTEGER 0/1 and converted back to a real boolean on read.
 */

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '@/ui/logger'
import type { EventSubscription } from './eventTypes'

interface EventRow {
  id: string
  eventType: string
  matchKey: string | null
  directory: string
  prompt: string
  tier: string
  preset: string
  untrustedInput: number | null
  maxBudgetUsd: number | null
  maxTurns: number | null
  timeoutMs: number | null
  allowedTools: string | null
  dispositionTopic: string | null
  account: string | null
  enabled: number
  createdAt: number
}

function rowToSubscription(row: EventRow): EventSubscription {
  const subscription: EventSubscription = {
    id: row.id,
    eventType: row.eventType,
    directory: row.directory,
    prompt: row.prompt,
    tier: row.tier as EventSubscription['tier'],
    preset: row.preset,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
  }
  if (row.matchKey !== null) subscription.matchKey = row.matchKey
  if (row.untrustedInput !== null) subscription.untrustedInput = row.untrustedInput === 1
  if (row.maxBudgetUsd !== null) subscription.maxBudgetUsd = row.maxBudgetUsd
  if (row.maxTurns !== null) subscription.maxTurns = row.maxTurns
  if (row.timeoutMs !== null) subscription.timeoutMs = row.timeoutMs
  if (row.allowedTools !== null) subscription.allowedTools = parseAllowedTools(row.allowedTools, row.id)
  if (row.dispositionTopic !== null) subscription.dispositionTopic = row.dispositionTopic
  if (row.account !== null) subscription.account = row.account
  return subscription
}

/**
 * Parse the allowedTools JSON column, tolerating a corrupt row (F6). A single
 * malformed value must not throw out of list() — the trigger-event path lists
 * subscriptions to match an event, and one bad row would drop every match.
 * Degrade to no allowlist with a logged warning, mirroring parseTriggerMetadata.
 */
function parseAllowedTools(raw: string, id: string): string[] {
  try {
    return JSON.parse(raw) as string[]
  } catch (error) {
    logger.warn(`[EVENT STORE] corrupt allowedTools for subscription ${id}, treating as empty:`, error)
    return []
  }
}

export class EventStore {
  private readonly db: Database.Database

  constructor(dbPath: string = join(homedir(), '.happy', 'jobs.db')) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_subscriptions (
        id TEXT PRIMARY KEY,
        eventType TEXT NOT NULL,
        matchKey TEXT,
        directory TEXT NOT NULL,
        prompt TEXT NOT NULL,
        tier TEXT NOT NULL,
        preset TEXT NOT NULL,
        untrustedInput INTEGER,
        maxBudgetUsd REAL,
        maxTurns INTEGER,
        timeoutMs INTEGER,
        allowedTools TEXT,
        dispositionTopic TEXT,
        account TEXT,
        enabled INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `)
    // Idempotent migrations for stores created before these columns existed.
    // untrustedInput (E04-sweep); dispositionTopic was set by the builders but
    // never persisted (E05 gate saw undefined for every event job → fail-closed
    // hold); account is E10.
    const cols = this.db.prepare(`PRAGMA table_info(event_subscriptions)`).all() as { name: string }[]
    if (!cols.some(c => c.name === 'untrustedInput')) {
      this.db.exec(`ALTER TABLE event_subscriptions ADD COLUMN untrustedInput INTEGER`)
    }
    if (!cols.some(c => c.name === 'dispositionTopic')) {
      this.db.exec(`ALTER TABLE event_subscriptions ADD COLUMN dispositionTopic TEXT`)
    }
    if (!cols.some(c => c.name === 'account')) {
      this.db.exec(`ALTER TABLE event_subscriptions ADD COLUMN account TEXT`)
    }
    // Index the hot match path: trigger-event filters enabled subscriptions by eventType.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_event_subscriptions_event_type ON event_subscriptions (eventType, enabled)`)
  }

  create(s: EventSubscription): void {
    this.db.prepare(`
      INSERT INTO event_subscriptions (
        id, eventType, matchKey, directory, prompt, tier, preset, untrustedInput,
        maxBudgetUsd, maxTurns, timeoutMs, allowedTools, dispositionTopic, account, enabled, createdAt
      ) VALUES (
        @id, @eventType, @matchKey, @directory, @prompt, @tier, @preset, @untrustedInput,
        @maxBudgetUsd, @maxTurns, @timeoutMs, @allowedTools, @dispositionTopic, @account, @enabled, @createdAt
      )
    `).run({
      id: s.id,
      eventType: s.eventType,
      matchKey: s.matchKey ?? null,
      directory: s.directory,
      prompt: s.prompt,
      tier: s.tier,
      preset: s.preset,
      untrustedInput: s.untrustedInput === undefined ? null : (s.untrustedInput ? 1 : 0),
      maxBudgetUsd: s.maxBudgetUsd ?? null,
      maxTurns: s.maxTurns ?? null,
      timeoutMs: s.timeoutMs ?? null,
      allowedTools: s.allowedTools !== undefined ? JSON.stringify(s.allowedTools) : null,
      dispositionTopic: s.dispositionTopic ?? null,
      account: s.account ?? null,
      enabled: s.enabled ? 1 : 0,
      createdAt: s.createdAt,
    })
  }

  get(id: string): EventSubscription | undefined {
    const row = this.db.prepare('SELECT * FROM event_subscriptions WHERE id = ?').get(id) as EventRow | undefined
    return row ? rowToSubscription(row) : undefined
  }

  list(): EventSubscription[] {
    const rows = this.db.prepare('SELECT * FROM event_subscriptions ORDER BY createdAt ASC').all() as EventRow[]
    return rows.map(rowToSubscription)
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM event_subscriptions WHERE id = ?').run(id)
    return result.changes === 1
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE event_subscriptions SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  /** Close the underlying SQLite connection (daemon shutdown, ARCH-5). */
  close(): void {
    this.db.close()
  }
}
