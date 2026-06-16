import { describe, it, expect } from 'vitest';
import { shouldAutoApprove } from './runtimeGate';
import type { DispositionRollup } from './types';

const rollup: DispositionRollup = {
  generatedFrom: 5,
  domains: {
    security: { a: 2, m: 0, o: 0, d: 0, n: 2, bucket: 'high-trust' },
    architecture: { a: 13, m: 41, o: 3, d: 0, n: 57, bucket: 'modify-prone' },
  },
  topics: {},
};

describe('shouldAutoApprove', () => {
  it('high-trust + non-dangerous tool -> true', () => {
    expect(shouldAutoApprove('Read', 'security/x', rollup)).toBe(true);
    expect(shouldAutoApprove('Grep', 'security/x', rollup)).toBe(true);
  });
  it('high-trust + dangerous tool (Bash/Write/Edit) -> false (D-E05-8 floor)', () => {
    expect(shouldAutoApprove('Bash', 'security/x', rollup)).toBe(false);
    expect(shouldAutoApprove('Write', 'security/x', rollup)).toBe(false);
    expect(shouldAutoApprove('Edit', 'security/x', rollup)).toBe(false);
  });
  it('high-trust + non-safe-list tool (Task/WebFetch/WebSearch/mcp__*/KillBash) -> false (safe-list floor, SEC-001)', () => {
    // The floor is an explicit read-only ALLOW-list, not a deny-list: any tool
    // outside it (sub-agent spawn, network egress, MCP, …) is never auto-approved.
    expect(shouldAutoApprove('Task', 'security/x', rollup)).toBe(false);
    expect(shouldAutoApprove('WebFetch', 'security/x', rollup)).toBe(false);
    expect(shouldAutoApprove('WebSearch', 'security/x', rollup)).toBe(false);
    expect(shouldAutoApprove('mcp__memory__create_entities', 'security/x', rollup)).toBe(false);
    expect(shouldAutoApprove('KillBash', 'security/x', rollup)).toBe(false);
  });
  it('non-high-trust bucket -> false', () => {
    expect(shouldAutoApprove('Read', 'architecture/x', rollup)).toBe(false);
  });
  it('no topic / no rollup / unknown -> false (fail-closed)', () => {
    expect(shouldAutoApprove('Read', undefined, rollup)).toBe(false);
    expect(shouldAutoApprove('Read', 'security/x', null)).toBe(false);
    expect(shouldAutoApprove('Read', 'marketing/x', rollup)).toBe(false);
  });
});
