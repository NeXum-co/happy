/**
 * Tests for eventTrigger — the pure mapping layer that matches incoming events
 * against EventSubscriptions and turns a matched subscription + payload into a
 * pending event JobRecord.
 *
 * All functions are pure: time and id come in as arguments, so every assertion
 * is deterministic. Mirrors the cronFeeder test conventions.
 */

import { describe, it, expect } from 'vitest'
import {
  matchSubscriptions,
  buildEventJob,
  buildEventSubscriptionFromSubmit,
} from './eventTrigger'
import type { SubmitEventSubscriptionParams } from './eventTrigger'
import type { EventSubscription } from './eventTypes'

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)

function makeSub(overrides: Partial<EventSubscription> = {}): EventSubscription {
  return {
    id: 'sub-1',
    eventType: 'git.commit',
    directory: '/tmp/repo',
    prompt: 'review the commit',
    tier: 'supervised',
    preset: 'local-qwen',
    enabled: true,
    createdAt: T0,
    ...overrides,
  }
}

describe('matchSubscriptions', () => {
  it('matches a subscription with no matchKey for any payload of that eventType', () => {
    const sub = makeSub()
    expect(matchSubscriptions([sub], 'git.commit', '/tmp/repo')).toEqual([sub])
    expect(matchSubscriptions([sub], 'git.commit', undefined)).toEqual([sub])
    expect(matchSubscriptions([sub], 'git.commit', '/other')).toEqual([sub])
  })

  it('matches a matchKey-subscription only when payloadMatchKey is equal', () => {
    const sub = makeSub({ matchKey: '/tmp/repo' })
    expect(matchSubscriptions([sub], 'git.commit', '/tmp/repo')).toEqual([sub])
    expect(matchSubscriptions([sub], 'git.commit', '/other')).toEqual([])
    expect(matchSubscriptions([sub], 'git.commit', undefined)).toEqual([])
  })

  it('never matches a disabled subscription', () => {
    const sub = makeSub({ enabled: false })
    expect(matchSubscriptions([sub], 'git.commit', '/tmp/repo')).toEqual([])
  })

  it('returns empty for a non-matching eventType', () => {
    const sub = makeSub()
    expect(matchSubscriptions([sub], 'git.push', '/tmp/repo')).toEqual([])
  })

  it('returns every matching subscription from a mixed list', () => {
    const a = makeSub({ id: 'a' })
    const b = makeSub({ id: 'b', matchKey: '/tmp/repo' })
    const c = makeSub({ id: 'c', eventType: 'git.push' })
    const d = makeSub({ id: 'd', enabled: false })
    const e = makeSub({ id: 'e', matchKey: '/other' })

    expect(matchSubscriptions([a, b, c, d, e], 'git.commit', '/tmp/repo')).toEqual([a, b])
  })
})

describe('buildEventJob', () => {
  it('builds a pending event job with idempotency-key id and payload in metadata', () => {
    const sub = makeSub()
    const payload = { sha: 'abc123', repo: '/tmp/repo' }

    const job = buildEventJob(sub, payload, 'abc123', T0)

    expect(job.id).toBe(`event:${sub.id}:abc123`)
    expect(job.triggerType).toBe('event')
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(0)
    expect(job.maxAttempts).toBe(5)
    expect(job.tier).toBe('supervised')
    expect(job.preset).toBe('local-qwen')
    expect(job.directory).toBe(sub.directory)
    expect(job.prompt).toBe(sub.prompt)
    expect(job.createdAt).toBe(T0)
    expect(job.scheduledAt).toBeUndefined()
    expect(JSON.parse(job.triggerMetadata)).toEqual({
      subscriptionId: sub.id,
      eventType: sub.eventType,
      payload,
      idempotencyKey: 'abc123',
      allowedTools: [],
    })
  })

  it('uses newId when supplied, ignoring the idempotency key for the id', () => {
    const sub = makeSub()

    const job = buildEventJob(sub, { sha: 'z' }, undefined, T0, (subId) => `gen:${subId}:42`)

    expect(job.id).toBe('gen:sub-1:42')
    expect(JSON.parse(job.triggerMetadata).idempotencyKey).toBeUndefined()
  })

  it('throws when neither idempotencyKey nor newId is supplied', () => {
    const sub = makeSub()
    expect(() => buildEventJob(sub, { sha: 'z' }, undefined, T0)).toThrow()
  })

  it('includes optional caps and timeoutAt only when the subscription sets them', () => {
    const sub = makeSub({ maxBudgetUsd: 2.5, maxTurns: 40, timeoutMs: 600_000, allowedTools: ['Read'] })

    const job = buildEventJob(sub, { sha: 'z' }, 'key', T0)

    expect(job.maxBudgetUsd).toBe(2.5)
    expect(job.maxTurns).toBe(40)
    expect(job.timeoutAt).toBe(T0 + 600_000)
    expect(JSON.parse(job.triggerMetadata).allowedTools).toEqual(['Read'])
  })

  it('omits optional caps and defaults allowedTools to [] when the subscription has none', () => {
    const sub = makeSub()

    const job = buildEventJob(sub, { sha: 'z' }, 'key', T0)

    expect(job.maxBudgetUsd).toBeUndefined()
    expect(job.maxTurns).toBeUndefined()
    expect(job.timeoutAt).toBeUndefined()
    expect(JSON.parse(job.triggerMetadata).allowedTools).toEqual([])
  })
})

describe('buildEventSubscriptionFromSubmit', () => {
  it('applies defaults (supervised tier, local-qwen preset, enabled) and round-trips id/createdAt', () => {
    const params: SubmitEventSubscriptionParams = {
      eventType: 'git.commit',
      directory: '/tmp/repo',
      prompt: 'review the commit',
    }

    const sub = buildEventSubscriptionFromSubmit(params, T0, 'sub-xyz')

    expect(sub.id).toBe('sub-xyz')
    expect(sub.eventType).toBe('git.commit')
    expect(sub.directory).toBe('/tmp/repo')
    expect(sub.prompt).toBe('review the commit')
    expect(sub.tier).toBe('supervised')
    expect(sub.preset).toBe('local-qwen')
    expect(sub.enabled).toBe(true)
    expect(sub.createdAt).toBe(T0)
    expect(sub.matchKey).toBeUndefined()
    expect(sub.maxBudgetUsd).toBeUndefined()
    expect(sub.maxTurns).toBeUndefined()
    expect(sub.timeoutMs).toBeUndefined()
    expect(sub.allowedTools).toBeUndefined()
  })

  it('honours an explicit tier/preset over the defaults', () => {
    const params: SubmitEventSubscriptionParams = {
      eventType: 'git.commit',
      directory: '/tmp/repo',
      prompt: 'p',
      tier: 'trusted',
      preset: 'claude-cloud',
    }

    const sub = buildEventSubscriptionFromSubmit(params, T0, 'sub-1')

    expect(sub.tier).toBe('trusted')
    expect(sub.preset).toBe('claude-cloud')
  })

  it('copies matchKey and optional caps only when set', () => {
    const params: SubmitEventSubscriptionParams = {
      eventType: 'git.commit',
      matchKey: '/tmp/repo',
      directory: '/tmp/repo',
      prompt: 'p',
      maxBudgetUsd: 2.5,
      maxTurns: 40,
      timeoutMs: 600_000,
      allowedTools: ['Read'],
    }

    const sub = buildEventSubscriptionFromSubmit(params, T0, 'sub-1')

    expect(sub.matchKey).toBe('/tmp/repo')
    expect(sub.maxBudgetUsd).toBe(2.5)
    expect(sub.maxTurns).toBe(40)
    expect(sub.timeoutMs).toBe(600_000)
    expect(sub.allowedTools).toEqual(['Read'])
  })
})
