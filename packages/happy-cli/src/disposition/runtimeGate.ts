// src/disposition/runtimeGate.ts
/**
 * E05 runtime gate — pure. Decides whether an autonomous SUPERVISED job may
 * auto-approve a tool escalation instead of forwarding it to Joshua. Only a
 * high-trust disposition topic combined with a KNOWN read-only tool qualifies
 * (the safe-list floor, D-E05-8 / SEC-001). The list is an explicit ALLOW-list,
 * not a deny-list: any unrecognized tool (Task, WebFetch, WebSearch, mcp__*,
 * Bash/Write/Edit, …) is never auto-approved, so the gate fails closed for the
 * long tail of tools (D-E05-5). Everything else is false → the caller falls
 * through to the existing needs-you escalation.
 */
import { evaluate } from './gate';
import type { DispositionRollup } from './types';

/**
 * Tools the runtime gate may auto-approve under a high-trust topic. Deliberately
 * read-only / local-only / no-egress: no file writes, no Bash, no sub-agent
 * spawn (Task), no network (WebFetch/WebSearch), no MCP. Adding a tool here
 * widens autonomous auto-approval and must be a conscious safety decision.
 */
const AUTO_APPROVE_TOOLS = new Set<string>([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'BashOutput',
]);

/**
 * @returns `true` only when `toolName` is on the read-only safe-list AND the
 *          topic resolves to a high-trust bucket. Any unknown tool, non-high-trust
 *          topic, or missing rollup returns `false` → the caller forwards the
 *          escalation to Joshua (fail-closed, D-E05-5/8).
 */
export function shouldAutoApprove(toolName: string, topic: string | null | undefined, rollup: DispositionRollup | null): boolean {
  if (!AUTO_APPROVE_TOOLS.has(toolName)) return false;
  return evaluate(topic, rollup).bucket === 'high-trust';
}
