/**
 * Unit tests for the SQLite-backed event subscription store.
 *
 * Each test uses a fresh tmp db file. create/get round-trips a full record
 * (optionals absent stay undefined, including matchKey). list() orders by
 * createdAt ASC. delete() returns true on first call, false on second
 * (idempotent). setEnabled toggles the persisted boolean. enabled round-trips
 * as a real boolean.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from './eventStore'
import type { EventSubscription } from './eventTypes'

function makeSubscription(overrides: Partial<EventSubscription> = {}): EventSubscription {
  return {
    id: 'event-1',
    eventType: 'git.commit',
    matchKey: '/tmp/repo',
    directory: '/tmp/work',
    prompt: 'do the thing',
    tier: 'trusted',
    preset: 'local-qwen',
    enabled: true,
    createdAt: 1000,
    ...overrides,
  }
}

describe('EventStore', () => {
  let dir: string
  let dbPath: string
  let store: EventStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-eventstore-test-'))
    dbPath = join(dir, 'jobs.db')
    store = new EventStore(dbPath)
    store.init()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a full record including matchKey and populated allowedTools', () => {
    const subscription = makeSubscription({
      id: 'event-rt',
      maxBudgetUsd: 1.5,
      maxTurns: 20,
      timeoutMs: 60000,
      allowedTools: ['Read', 'Write', 'Bash'],
    })
    store.create(subscription)

    const loaded = store.get('event-rt')
    expect(loaded).toBeDefined()
    expect(loaded!.id).toBe('event-rt')
    expect(loaded!.eventType).toBe('git.commit')
    expect(loaded!.matchKey).toBe('/tmp/repo')
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

  it('round-trips a record without matchKey (column NULL)', () => {
    store.create(makeSubscription({ id: 'event-nokey', matchKey: undefined }))

    const loaded = store.get('event-nokey')!
    expect(loaded.matchKey).toBeUndefined()
  })

  it('round-trips a record with undefined allowedTools (column NULL)', () => {
    store.create(makeSubscription({ id: 'event-notools' }))

    const loaded = store.get('event-notools')!
    expect(loaded.allowedTools).toBeUndefined()
  })

  it('enabled round-trips as a real boolean', () => {
    store.create(makeSubscription({ id: 'event-enabled', enabled: true }))
    store.create(makeSubscription({ id: 'event-disabled', enabled: false }))

    const enabled = store.get('event-enabled')!
    expect(enabled.enabled).toBe(true)
    expect(typeof enabled.enabled).toBe('boolean')

    const disabled = store.get('event-disabled')!
    expect(disabled.enabled).toBe(false)
    expect(typeof disabled.enabled).toBe('boolean')
  })

  it('list() orders by createdAt ASC', () => {
    store.create(makeSubscription({ id: 'event-b', createdAt: 3000 }))
    store.create(makeSubscription({ id: 'event-a', createdAt: 1000 }))
    store.create(makeSubscription({ id: 'event-c', createdAt: 5000 }))

    const list = store.list()
    expect(list.map(s => s.id)).toEqual(['event-a', 'event-b', 'event-c'])
  })

  it('delete() returns true then false on second call', () => {
    store.create(makeSubscription({ id: 'event-del' }))

    expect(store.delete('event-del')).toBe(true)
    expect(store.get('event-del')).toBeUndefined()
    expect(store.delete('event-del')).toBe(false)
  })

  it('setEnabled toggles the persisted value', () => {
    store.create(makeSubscription({ id: 'event-toggle', enabled: true }))

    store.setEnabled('event-toggle', false)
    expect(store.get('event-toggle')!.enabled).toBe(false)

    store.setEnabled('event-toggle', true)
    expect(store.get('event-toggle')!.enabled).toBe(true)
  })

  it('returns undefined for an unknown id', () => {
    expect(store.get('no-such-event')).toBeUndefined()
  })

  it('optional fields absent stay undefined', () => {
    store.create(makeSubscription({ id: 'event-bare', matchKey: undefined }))

    const loaded = store.get('event-bare')!
    expect(loaded.matchKey).toBeUndefined()
    expect(loaded.maxBudgetUsd).toBeUndefined()
    expect(loaded.maxTurns).toBeUndefined()
    expect(loaded.timeoutMs).toBeUndefined()
    expect(loaded.allowedTools).toBeUndefined()
  })

  it('round-trips dispositionTopic (pre-existing fix) en account (E10)', () => {
    store.create(makeSubscription({ id: 'event-meta', dispositionTopic: 'deploy', account: 'work' }))
    const loaded = store.get('event-meta')!
    expect(loaded.dispositionTopic).toBe('deploy') // ging vóór de fix verloren → E05-gate undefined
    expect(loaded.account).toBe('work')
  })
})
