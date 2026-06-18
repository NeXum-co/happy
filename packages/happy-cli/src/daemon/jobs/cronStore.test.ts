/**
 * Unit tests for the SQLite-backed cron schedule store.
 *
 * Each test uses a fresh tmp db file. create/get round-trips a full record
 * (optionals absent stay undefined). list() orders by createdAt ASC.
 * delete() returns true on first call, false on second (idempotent).
 * setEnabled toggles the persisted boolean. enabled round-trips as a real boolean.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronStore } from './cronStore'
import type { CronSchedule } from './cronTypes'

function makeSchedule(overrides: Partial<CronSchedule> = {}): CronSchedule {
  return {
    id: 'cron-1',
    cronExpr: '0 * * * *',
    directory: '/tmp/work',
    prompt: 'do the thing',
    tier: 'trusted',
    preset: 'local-qwen',
    enabled: true,
    createdAt: 1000,
    ...overrides,
  }
}

describe('CronStore', () => {
  let dir: string
  let dbPath: string
  let store: CronStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-cronstore-test-'))
    dbPath = join(dir, 'jobs.db')
    store = new CronStore(dbPath)
    store.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a full record including populated allowedTools', () => {
    const schedule = makeSchedule({
      id: 'cron-rt',
      maxBudgetUsd: 1.5,
      maxTurns: 20,
      timeoutMs: 60000,
      allowedTools: ['Read', 'Write', 'Bash'],
    })
    store.create(schedule)

    const loaded = store.get('cron-rt')
    expect(loaded).toBeDefined()
    expect(loaded!.id).toBe('cron-rt')
    expect(loaded!.cronExpr).toBe('0 * * * *')
    expect(loaded!.directory).toBe('/tmp/work')
    expect(loaded!.prompt).toBe('do the thing')
    expect(loaded!.tier).toBe('trusted')
    expect(loaded!.preset).toBe('local-qwen')
    expect(loaded!.maxBudgetUsd).toBe(1.5)
    expect(loaded!.maxTurns).toBe(20)
    expect(loaded!.timeoutMs).toBe(60000)
    expect(loaded!.allowedTools).toEqual(['Read', 'Write', 'Bash'])
    expect(loaded!.enabled).toBe(true)
    expect(loaded!.createdAt).toBe(1000)
  })

  it('round-trips a record with undefined allowedTools (column NULL)', () => {
    store.create(makeSchedule({ id: 'cron-notools' }))

    const loaded = store.get('cron-notools')!
    expect(loaded.allowedTools).toBeUndefined()
  })

  it('enabled round-trips as a real boolean', () => {
    store.create(makeSchedule({ id: 'cron-enabled', enabled: true }))
    store.create(makeSchedule({ id: 'cron-disabled', enabled: false }))

    const enabled = store.get('cron-enabled')!
    expect(enabled.enabled).toBe(true)
    expect(typeof enabled.enabled).toBe('boolean')

    const disabled = store.get('cron-disabled')!
    expect(disabled.enabled).toBe(false)
    expect(typeof disabled.enabled).toBe('boolean')
  })

  it('list() orders by createdAt ASC', () => {
    store.create(makeSchedule({ id: 'cron-b', createdAt: 3000 }))
    store.create(makeSchedule({ id: 'cron-a', createdAt: 1000 }))
    store.create(makeSchedule({ id: 'cron-c', createdAt: 5000 }))

    const list = store.list()
    expect(list.map(s => s.id)).toEqual(['cron-a', 'cron-b', 'cron-c'])
  })

  it('delete() returns true then false on second call', () => {
    store.create(makeSchedule({ id: 'cron-del' }))

    expect(store.delete('cron-del')).toBe(true)
    expect(store.get('cron-del')).toBeUndefined()
    expect(store.delete('cron-del')).toBe(false)
  })

  it('setEnabled toggles the persisted value', () => {
    store.create(makeSchedule({ id: 'cron-toggle', enabled: true }))

    store.setEnabled('cron-toggle', false)
    expect(store.get('cron-toggle')!.enabled).toBe(false)

    store.setEnabled('cron-toggle', true)
    expect(store.get('cron-toggle')!.enabled).toBe(true)
  })

  it('returns undefined for an unknown id', () => {
    expect(store.get('no-such-cron')).toBeUndefined()
  })

  it('optional fields absent stay undefined', () => {
    store.create(makeSchedule({ id: 'cron-bare' }))

    const loaded = store.get('cron-bare')!
    expect(loaded.maxBudgetUsd).toBeUndefined()
    expect(loaded.maxTurns).toBeUndefined()
    expect(loaded.timeoutMs).toBeUndefined()
    expect(loaded.allowedTools).toBeUndefined()
  })

  it('round-trips untrustedInput as a boolean (true/false/absent)', () => {
    store.create(makeSchedule({ id: 'cron-untrusted', untrustedInput: true }))
    store.create(makeSchedule({ id: 'cron-clean', untrustedInput: false }))
    store.create(makeSchedule({ id: 'cron-noflag' }))

    expect(store.get('cron-untrusted')!.untrustedInput).toBe(true)
    expect(store.get('cron-clean')!.untrustedInput).toBe(false)
    expect(store.get('cron-noflag')!.untrustedInput).toBeUndefined()
  })

  it('F6: a corrupt allowedTools row degrades to [] instead of throwing out of list()', () => {
    store.create(makeSchedule({ id: 'cron-good', allowedTools: ['Read'] }))
    store.create(makeSchedule({ id: 'cron-corrupt', allowedTools: ['Write'] }))

    // Corrupt one row's JSON directly, as a partial write or a bad migration might.
    const raw = new Database(dbPath)
    raw.prepare(`UPDATE cron_schedules SET allowedTools = ? WHERE id = ?`).run('{not valid json', 'cron-corrupt')
    raw.close()

    // list() must not throw — that would abort the whole feeder tick (SF-4 sibling).
    const all = store.list()
    expect(all.length).toBe(2)
    expect(all.find(s => s.id === 'cron-good')!.allowedTools).toEqual(['Read'])
    expect(all.find(s => s.id === 'cron-corrupt')!.allowedTools).toEqual([])
  })
})
