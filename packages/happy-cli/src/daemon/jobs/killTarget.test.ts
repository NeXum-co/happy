import { describe, it, expect } from 'vitest';
import { resolveKillTarget } from './killTarget';

describe('resolveKillTarget', () => {
  it('returns the pid when the sessionId still maps to it', () => {
    const sessions = new Map<number, { happySessionId?: string }>([
      [101, { happySessionId: 'sess-a' }],
      [102, { happySessionId: 'sess-b' }],
    ]);
    expect(resolveKillTarget('sess-a', sessions)).toBe(101);
    expect(resolveKillTarget('sess-b', sessions)).toBe(102);
  });

  it('returns undefined when the session is gone', () => {
    const sessions = new Map<number, { happySessionId?: string }>([
      [101, { happySessionId: 'sess-a' }],
    ]);
    expect(resolveKillTarget('sess-gone', sessions)).toBeUndefined();
  });

  it('returns undefined when the pid was reused by a different session (stale mapping)', () => {
    // The captured pid 101 now belongs to a different session — must NOT kill it.
    const sessions = new Map<number, { happySessionId?: string }>([
      [101, { happySessionId: 'sess-reused' }],
    ]);
    expect(resolveKillTarget('sess-a', sessions)).toBeUndefined();
  });

  it('ignores tracked entries without a happySessionId', () => {
    const sessions = new Map<number, { happySessionId?: string }>([
      [101, {}],
      [102, { happySessionId: 'sess-b' }],
    ]);
    expect(resolveKillTarget('sess-a', sessions)).toBeUndefined();
    expect(resolveKillTarget('sess-b', sessions)).toBe(102);
  });

  it('resolves the PID- prefixed sessionId form to the bare pid when tracked', () => {
    const sessions = new Map<number, { happySessionId?: string }>([
      [555, {}],
      [556, { happySessionId: 'sess-b' }],
    ]);
    expect(resolveKillTarget('PID-555', sessions)).toBe(555);
  });

  it('returns undefined for a PID- form whose pid is not tracked', () => {
    const sessions = new Map<number, { happySessionId?: string }>([
      [556, { happySessionId: 'sess-b' }],
    ]);
    expect(resolveKillTarget('PID-555', sessions)).toBeUndefined();
  });
});
