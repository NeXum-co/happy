/**
 * Integration test for the event spine (slice 3).
 *
 * This wires the SAME object graph the daemon's triggerEvent closure builds — an
 * EventStore and a JobStore over ONE real SQLite file — and exercises the full
 * path an event travels INLINE (no daemon, no relay, no auth, no module mocks,
 * no account): submit (buildEventSubscriptionFromSubmit + eventStore.create) →
 * an event arrives → matchSubscriptions selects the enabled subscriptions →
 * buildEventJob turns each match into a pending triggerType:'event' JobRecord →
 * jobStore.createIfAbsent persists it (idempotency-key dedupe) → jobStore.claimNext
 * claims and runs it. Mirrors cronIntegration.test.ts: real compiled modules over
 * real persistence with one injected clock.
 *
 * Covers:
 *  - an event creates a pending event job carrying the payload in triggerMetadata,
 *    and the scheduler claims it;
 *  - re-delivering the SAME idempotencyKey dedupes via the deterministic id +
 *    createIfAbsent (only one row);
 *  - a non-matching event (wrong matchKey or wrong eventType) selects nothing,
 *    so no jobs are created.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from './eventStore'
import { JobStore } from './jobStore'
import { matchSubscriptions, buildEventJob, buildEventSubscriptionFromSubmit } from './eventTrigger'

// A fixed UTC base on a minute boundary so id/time math is deterministic
// regardless of the host timezone.
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0) // 2026-01-01T00:00:00Z

describe('event spine integration', () => {
  let dir: string
  let eventStore: EventStore
  let jobStore: JobStore
  let clock: number
  const now = () => clock

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-event-integ-'))
    const dbPath = join(dir, 'jobs.db')
    // The daemon shares one jobs.db between both stores (WAL). Mirror that.
    jobStore = new JobStore(dbPath)
    jobStore.init()
    eventStore = new EventStore(dbPath)
    eventStore.init()
    clock = T0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('an event creates a pending event job carrying the payload, and the scheduler claims it', () => {
    eventStore.create(
      buildEventSubscriptionFromSubmit(
        { eventType: 'git.commit', matchKey: '/repo/x', directory: '/repo/x', prompt: 'review' },
        clock,
        'sub-1',
      ),
    )

    // Mirror of the daemon's triggerEvent closure: match, then build+persist a job
    // per match keyed by the event's idempotency key.
    const payload = { sha: 'abc', branch: 'main', message: 'm' }
    const subs = matchSubscriptions(eventStore.list(), 'git.commit', '/repo/x')
    expect(subs).toHaveLength(1)
    for (const sub of subs) {
      jobStore.createIfAbsent(buildEventJob(sub, payload, 'abc', clock, undefined))
    }

    // AC1: a triggerType:'event' job appears with the sha present in triggerMetadata.
    const eventJobs = jobStore.list().filter(j => j.triggerType === 'event')
    expect(eventJobs).toHaveLength(1)
    const job = eventJobs[0]
    expect(job.status).toBe('pending')
    expect(job.directory).toBe('/repo/x')
    expect(job.prompt).toBe('review')
    const meta = JSON.parse(job.triggerMetadata) as { subscriptionId: string; payload: { sha: string } }
    expect(meta.subscriptionId).toBe('sub-1')
    expect(meta.payload.sha).toBe('abc')

    // AC2: the scheduler claims it (event jobs have no scheduledAt → immediately claimable).
    const claimed = jobStore.claimNext(clock)
    expect(claimed).toBeDefined()
    expect(claimed!.id).toBe(job.id)
    expect(claimed!.triggerType).toBe('event')
    expect(claimed!.status).toBe('running')
    expect(jobStore.get(job.id)!.status).toBe('running')
  })

  it('re-delivering the same idempotencyKey dedupes: only one job row', () => {
    eventStore.create(
      buildEventSubscriptionFromSubmit(
        { eventType: 'git.commit', matchKey: '/repo/x', directory: '/repo/x', prompt: 'review' },
        clock,
        'sub-1',
      ),
    )

    const payload = { sha: 'abc', branch: 'main', message: 'm' }
    const subs = matchSubscriptions(eventStore.list(), 'git.commit', '/repo/x')
    expect(subs).toHaveLength(1)
    const sub = subs[0]

    // First delivery creates the row.
    const first = jobStore.createIfAbsent(buildEventJob(sub, payload, 'abc', clock, undefined))
    expect(first).toBe(true)

    // Re-delivery of the SAME idempotency key ('abc') is a no-op: deterministic id
    // `event:sub-1:abc` already exists → createIfAbsent returns false.
    const second = jobStore.createIfAbsent(buildEventJob(sub, payload, 'abc', clock, undefined))
    expect(second).toBe(false)

    // Only one job row for that subscription.
    const subJobs = jobStore
      .list()
      .filter(j => j.triggerType === 'event')
      .filter(j => (JSON.parse(j.triggerMetadata) as { subscriptionId: string }).subscriptionId === 'sub-1')
    expect(subJobs).toHaveLength(1)
  })

  it('a non-matching event selects nothing and creates no jobs (wrong matchKey or wrong eventType)', () => {
    eventStore.create(
      buildEventSubscriptionFromSubmit(
        { eventType: 'git.commit', matchKey: '/repo/x', directory: '/repo/x', prompt: 'review' },
        clock,
        'sub-1',
      ),
    )

    // matchKey mismatch: same type, different repo → no match.
    const wrongKey = matchSubscriptions(eventStore.list(), 'git.commit', '/other/repo')
    expect(wrongKey).toHaveLength(0)

    // type mismatch: different eventType, same matchKey → no match.
    const wrongType = matchSubscriptions(eventStore.list(), 'other.event', '/repo/x')
    expect(wrongType).toHaveLength(0)

    // Neither path would create a job: the loops over the (empty) match sets run nothing.
    for (const sub of wrongKey) jobStore.createIfAbsent(buildEventJob(sub, {}, 'k', clock, undefined))
    for (const sub of wrongType) jobStore.createIfAbsent(buildEventJob(sub, {}, 'k', clock, undefined))
    expect(jobStore.list().filter(j => j.triggerType === 'event')).toHaveLength(0)
  })
})
