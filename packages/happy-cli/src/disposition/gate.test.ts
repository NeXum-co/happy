// src/disposition/gate.test.ts
import { describe, it, expect } from 'vitest';
import { evaluate } from './gate';
import type { DispositionRollup } from './types';

const rollup: DispositionRollup = {
  generatedFrom: 10,
  domains: {
    security: { a: 2, m: 0, o: 0, d: 0, n: 2, bucket: 'high-trust' },
    architecture: { a: 13, m: 41, o: 3, d: 0, n: 57, bucket: 'modify-prone' },
    compliance: { a: 1, m: 1, o: 1, d: 0, n: 3, bucket: 'mixed' },
  },
  topics: {
    'architecture/frontend': { a: 1, m: 7, o: 2, d: 0, n: 10, bucket: 'override-prone' },
  },
};

describe('evaluate', () => {
  it('high-trust domain -> proceed', () => {
    const v = evaluate('security/access-control', rollup);
    expect(v.action).toBe('proceed');
    expect(v.bucket).toBe('high-trust');
    expect(v.matchedTopic).toBe('security'); // fell back to domain
  });

  it('modify-prone domain -> proceed-supervised', () => {
    expect(evaluate('architecture/api-design', rollup).action).toBe('proceed-supervised');
  });

  it('exact topic wins over domain', () => {
    const v = evaluate('architecture/frontend', rollup);
    expect(v.bucket).toBe('override-prone');
    expect(v.action).toBe('hold');
    expect(v.matchedTopic).toBe('architecture/frontend');
  });

  it('mixed -> escalate', () => {
    expect(evaluate('compliance/red-zone', rollup).action).toBe('escalate');
  });

  it('unknown topic AND unknown domain -> hold (fail-closed)', () => {
    const v = evaluate('marketing/email', rollup);
    expect(v.action).toBe('hold');
    expect(v.matchedTopic).toBeNull();
  });

  it('null rollup -> hold (fail-closed)', () => {
    expect(evaluate('security/x', null).action).toBe('hold');
  });

  it('null/empty topic -> hold (fail-closed)', () => {
    expect(evaluate(null, rollup).action).toBe('hold');
    expect(evaluate('', rollup).action).toBe('hold');
  });
});
