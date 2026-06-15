/**
 * eventTrigger — the pure mapping layer between an incoming event and the
 * autonomous jobs it should spawn.
 *
 * The flow is: an event arrives (eventType + optional matchKey + payload),
 * matchSubscriptions selects the enabled EventSubscriptions it satisfies, and
 * buildEventJob turns each match into a pending event JobRecord. Event jobs have
 * NO scheduledAt — they are immediately claimable (claimNext treats an absent
 * scheduledAt as "now").
 *
 * Every function here is PURE: time and id come in as arguments (the caller's
 * closure supplies Date.now / a uuid generator), so the mapping is deterministic
 * and trivially testable. Mirrors the cron equivalents in ./cronFeeder.ts.
 */

import type { EventSubscription } from './eventTypes'
import type { JobRecord } from './jobTypes'

/**
 * Selects the enabled subscriptions that an event satisfies: same eventType, and
 * either no matchKey (matches any payload of that type) or a matchKey equal to
 * the event's payloadMatchKey.
 */
export function matchSubscriptions(
  subs: EventSubscription[],
  eventType: string,
  payloadMatchKey?: string,
): EventSubscription[] {
  return subs.filter(
    (s) =>
      s.enabled === true &&
      s.eventType === eventType &&
      (s.matchKey === undefined || s.matchKey === payloadMatchKey),
  )
}

/**
 * Pure mapping from a matched subscription + event payload to a fresh pending
 * event JobRecord. The id is supplied by the caller: either a deterministic
 * idempotency-key id (`event:{subId}:{key}`, so a re-delivered event dedupes via
 * createIfAbsent) or a generated id from newId. Exactly one must be present.
 * Optional caps are copied only when the subscription sets them; timeoutMs
 * becomes an absolute timeoutAt relative to `now`. No scheduledAt is set.
 */
export function buildEventJob(
  sub: EventSubscription,
  payload: unknown,
  idempotencyKey: string | undefined,
  now: number,
  newId?: (subId: string) => string,
): JobRecord {
  let id: string
  if (newId) {
    id = newId(sub.id)
  } else if (idempotencyKey !== undefined) {
    id = `event:${sub.id}:${idempotencyKey}`
  } else {
    throw new Error('buildEventJob requires either an idempotencyKey or a newId generator')
  }

  const job: JobRecord = {
    id,
    triggerType: 'event',
    triggerMetadata: JSON.stringify({
      subscriptionId: sub.id,
      eventType: sub.eventType,
      payload,
      idempotencyKey,
      allowedTools: sub.allowedTools ?? [],
    }),
    tier: sub.tier,
    preset: sub.preset,
    directory: sub.directory,
    prompt: sub.prompt,
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    createdAt: now,
  }
  if (sub.maxBudgetUsd !== undefined) job.maxBudgetUsd = sub.maxBudgetUsd
  if (sub.maxTurns !== undefined) job.maxTurns = sub.maxTurns
  if (sub.timeoutMs !== undefined) job.timeoutAt = now + sub.timeoutMs
  return job
}

/** Params accepted by the submit-event-subscription RPC / HTTP endpoint (E04). */
export interface SubmitEventSubscriptionParams {
  eventType: string
  matchKey?: string
  directory: string
  prompt: string
  tier?: 'trusted' | 'supervised'
  preset?: string
  maxBudgetUsd?: number
  maxTurns?: number
  timeoutMs?: number
  allowedTools?: string[]
}

/**
 * Pure mapping from submit params to a fresh enabled EventSubscription.
 * Defaults: supervised tier, 'local-qwen' preset, enabled. matchKey and the
 * optional caps are copied only when set. Mirrors buildCronFromSubmit.
 */
export function buildEventSubscriptionFromSubmit(
  params: SubmitEventSubscriptionParams,
  now: number,
  id: string,
): EventSubscription {
  const sub: EventSubscription = {
    id,
    eventType: params.eventType,
    directory: params.directory,
    prompt: params.prompt,
    tier: params.tier ?? 'supervised',
    preset: params.preset ?? 'local-qwen',
    enabled: true,
    createdAt: now,
  }
  if (params.matchKey !== undefined) sub.matchKey = params.matchKey
  if (params.maxBudgetUsd !== undefined) sub.maxBudgetUsd = params.maxBudgetUsd
  if (params.maxTurns !== undefined) sub.maxTurns = params.maxTurns
  if (params.timeoutMs !== undefined) sub.timeoutMs = params.timeoutMs
  if (params.allowedTools !== undefined) sub.allowedTools = params.allowedTools
  return sub
}
