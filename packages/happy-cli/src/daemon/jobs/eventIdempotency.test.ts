import { describe, it, expect } from 'vitest';
import { deriveEventIdempotencyKey, DEFAULT_EVENT_DEDUP_WINDOW_MS } from './eventIdempotency';

// A bucket-ALIGNED "now" (a multiple of the window) so T and T + (window-1) sit
// in the same bucket, and T + window is exactly the next bucket. Picking an
// unaligned T would straddle a boundary and make the window tests ambiguous.
const T = 17 * DEFAULT_EVENT_DEDUP_WINDOW_MS;

describe('deriveEventIdempotencyKey', () => {
  it('is deterministic: same inputs in the same window produce the same key', () => {
    const a = deriveEventIdempotencyKey('git.commit', '/repo', { sha: 'abc', branch: 'main' }, T);
    const b = deriveEventIdempotencyKey('git.commit', '/repo', { sha: 'abc', branch: 'main' }, T);
    expect(a).toBe(b);
  });

  it('is stable across payload key ordering', () => {
    const a = deriveEventIdempotencyKey('e', 'm', { x: 1, y: 2, z: { p: 1, q: 2 } }, T);
    const b = deriveEventIdempotencyKey('e', 'm', { z: { q: 2, p: 1 }, y: 2, x: 1 }, T);
    expect(a).toBe(b);
  });

  it('differs when eventType differs', () => {
    const a = deriveEventIdempotencyKey('git.commit', 'm', { sha: 'x' }, T);
    const b = deriveEventIdempotencyKey('git.push', 'm', { sha: 'x' }, T);
    expect(a).not.toBe(b);
  });

  it('differs when matchKey differs', () => {
    const a = deriveEventIdempotencyKey('e', '/repo-a', { sha: 'x' }, T);
    const b = deriveEventIdempotencyKey('e', '/repo-b', { sha: 'x' }, T);
    expect(a).not.toBe(b);
  });

  it('distinguishes an undefined matchKey from an empty-string matchKey', () => {
    const a = deriveEventIdempotencyKey('e', undefined, { sha: 'x' }, T);
    const b = deriveEventIdempotencyKey('e', '', { sha: 'x' }, T);
    expect(a).not.toBe(b);
  });

  it('differs when payload differs', () => {
    const a = deriveEventIdempotencyKey('e', 'm', { sha: 'x' }, T);
    const b = deriveEventIdempotencyKey('e', 'm', { sha: 'y' }, T);
    expect(a).not.toBe(b);
  });

  it('handles an undefined payload without throwing and treats undefined/null as "no payload"', () => {
    const a = deriveEventIdempotencyKey('e', 'm', undefined, T);
    const b = deriveEventIdempotencyKey('e', 'm', undefined, T);
    expect(a).toBe(b);
    // An absent payload field (undefined) and an explicit null are the same
    // logical event, so they dedupe together — by design.
    expect(a).toBe(deriveEventIdempotencyKey('e', 'm', null, T));
  });

  it('dedupes identical events within the same window bucket', () => {
    // Two deliveries a few seconds apart but inside one window → same key.
    const a = deriveEventIdempotencyKey('e', 'm', { sha: 'x' }, T);
    const b = deriveEventIdempotencyKey('e', 'm', { sha: 'x' }, T + DEFAULT_EVENT_DEDUP_WINDOW_MS - 1);
    expect(a).toBe(b);
  });

  it('produces a fresh key for the same event in a later window (legitimate repeat runs again)', () => {
    const a = deriveEventIdempotencyKey('e', 'm', { sha: 'x' }, T);
    const b = deriveEventIdempotencyKey('e', 'm', { sha: 'x' }, T + DEFAULT_EVENT_DEDUP_WINDOW_MS);
    expect(a).not.toBe(b);
  });

  it('honours a custom window size', () => {
    const same = deriveEventIdempotencyKey('e', 'm', { sha: 'x' }, 5_000, 10_000);
    const sameBucket = deriveEventIdempotencyKey('e', 'm', { sha: 'x' }, 9_999, 10_000);
    const nextBucket = deriveEventIdempotencyKey('e', 'm', { sha: 'x' }, 10_000, 10_000);
    expect(same).toBe(sameBucket);
    expect(same).not.toBe(nextBucket);
  });

  it('returns a short lowercase hex string', () => {
    const k = deriveEventIdempotencyKey('e', 'm', { sha: 'x' }, T);
    expect(k).toMatch(/^[0-9a-f]+$/);
    expect(k.length).toBeLessThanOrEqual(16);
    expect(k.length).toBeGreaterThan(0);
  });
});
