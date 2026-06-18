import { describe, it, expect } from 'vitest';
import { deriveEventIdempotencyKey } from './eventIdempotency';

describe('deriveEventIdempotencyKey', () => {
  it('is deterministic: same inputs produce the same key', () => {
    const a = deriveEventIdempotencyKey('git.commit', '/repo', { sha: 'abc', branch: 'main' });
    const b = deriveEventIdempotencyKey('git.commit', '/repo', { sha: 'abc', branch: 'main' });
    expect(a).toBe(b);
  });

  it('is stable across payload key ordering', () => {
    const a = deriveEventIdempotencyKey('e', 'm', { x: 1, y: 2, z: { p: 1, q: 2 } });
    const b = deriveEventIdempotencyKey('e', 'm', { z: { q: 2, p: 1 }, y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it('differs when eventType differs', () => {
    const a = deriveEventIdempotencyKey('git.commit', 'm', { sha: 'x' });
    const b = deriveEventIdempotencyKey('git.push', 'm', { sha: 'x' });
    expect(a).not.toBe(b);
  });

  it('differs when matchKey differs', () => {
    const a = deriveEventIdempotencyKey('e', '/repo-a', { sha: 'x' });
    const b = deriveEventIdempotencyKey('e', '/repo-b', { sha: 'x' });
    expect(a).not.toBe(b);
  });

  it('distinguishes an undefined matchKey from an empty-string matchKey', () => {
    const a = deriveEventIdempotencyKey('e', undefined, { sha: 'x' });
    const b = deriveEventIdempotencyKey('e', '', { sha: 'x' });
    expect(a).not.toBe(b);
  });

  it('differs when payload differs', () => {
    const a = deriveEventIdempotencyKey('e', 'm', { sha: 'x' });
    const b = deriveEventIdempotencyKey('e', 'm', { sha: 'y' });
    expect(a).not.toBe(b);
  });

  it('handles an undefined payload without throwing and treats undefined/null as "no payload"', () => {
    const a = deriveEventIdempotencyKey('e', 'm', undefined);
    const b = deriveEventIdempotencyKey('e', 'm', undefined);
    expect(a).toBe(b);
    // An absent payload field (undefined) and an explicit null are the same
    // logical event, so they dedupe together — by design.
    expect(a).toBe(deriveEventIdempotencyKey('e', 'm', null));
  });

  it('returns a short lowercase hex string', () => {
    const k = deriveEventIdempotencyKey('e', 'm', { sha: 'x' });
    expect(k).toMatch(/^[0-9a-f]+$/);
    expect(k.length).toBeLessThanOrEqual(16);
    expect(k.length).toBeGreaterThan(0);
  });
});
