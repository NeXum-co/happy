// src/disposition/runtimeGate.ts
/**
 * E05 runtime gate — pure. Decides whether an autonomous SUPERVISED job may
 * auto-approve a tool escalation instead of forwarding it to Joshua. Only
 * high-trust disposition topics AND non-dangerous tools qualify (the
 * dangerous-tool floor, D-E05-8). Everything else is false → the caller falls
 * through to the existing needs-you escalation (fail-closed, D-E05-5).
 */
import { evaluate } from './gate';
import { getToolDescriptor } from '@/claude/utils/getToolDescriptor';
import type { DispositionRollup } from './types';

export function shouldAutoApprove(toolName: string, topic: string | null | undefined, rollup: DispositionRollup | null): boolean {
  if (getToolDescriptor(toolName).dangerous) return false;
  return evaluate(topic, rollup).bucket === 'high-trust';
}
