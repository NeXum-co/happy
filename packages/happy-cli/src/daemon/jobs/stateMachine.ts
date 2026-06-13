/**
 * Job status state machine.
 *
 * Encodes the legal status transitions for a JobRecord. A running job that
 * exhausts its attempts reaches 'dead' only via 'failed' — never directly —
 * so transient and terminal failure stay distinguishable.
 */

import type { JobStatus } from './jobTypes'

const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  pending: ['running'],
  running: ['succeeded', 'failed', 'needs-attention'],
  failed: ['pending', 'dead'],
  'needs-attention': ['running', 'failed'],
  succeeded: [],
  dead: [],
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new Error(`Illegal job transition ${from} -> ${to}`)
}
