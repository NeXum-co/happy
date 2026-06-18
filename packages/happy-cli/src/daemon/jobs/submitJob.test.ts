/**
 * Unit tests for buildJobFromSubmit — the pure submit-job → JobRecord mapping.
 * Verifies defaults (supervised, local-qwen, 5 attempts, no transition state)
 * and optional field propagation (limits, timeout, allowedTools).
 */

import { describe, it, expect } from 'vitest'
import { buildJobFromSubmit, DEFAULT_MAX_TURNS, DEFAULT_MAX_BUDGET_USD, DEFAULT_TIMEOUT_MS } from './scheduler'

describe('buildJobFromSubmit', () => {
  it('applies default circuit-breakers for a minimal submit (F1 — no job runs with a null ceiling)', () => {
    const job = buildJobFromSubmit({ directory: '/work', prompt: 'go' }, 5000, 'id-1')

    expect(job.id).toBe('id-1')
    expect(job.triggerType).toBe('manual')
    expect(job.tier).toBe('supervised')
    expect(job.preset).toBe('local-qwen')
    expect(job.status).toBe('pending')
    expect(job.attempts).toBe(0)
    expect(job.maxAttempts).toBe(5)
    expect(job.createdAt).toBe(5000)
    expect(JSON.parse(job.triggerMetadata)).toEqual({ allowedTools: [] })
    // F1: every autonomous job gets a hard budget/turn/wall-clock ceiling even
    // when the caller omits them (D-E04-6).
    expect(job.maxTurns).toBe(DEFAULT_MAX_TURNS)
    expect(job.maxBudgetUsd).toBe(DEFAULT_MAX_BUDGET_USD)
    expect(job.timeoutAt).toBe(5000 + DEFAULT_TIMEOUT_MS)
  })

  it('propagates explicit fields and computes timeoutAt', () => {
    const job = buildJobFromSubmit({
      directory: '/work',
      prompt: 'go',
      tier: 'trusted',
      preset: 'cloud-opus',
      maxBudgetUsd: 3.5,
      maxTurns: 60,
      timeoutMs: 10_000,
      allowedTools: ['Read', 'Edit'],
    }, 5000, 'id-2')

    expect(job.tier).toBe('trusted')
    expect(job.preset).toBe('cloud-opus')
    expect(job.maxBudgetUsd).toBe(3.5)
    expect(job.maxTurns).toBe(60)
    expect(job.timeoutAt).toBe(15_000)
    expect(JSON.parse(job.triggerMetadata)).toEqual({ allowedTools: ['Read', 'Edit'] })
  })

  it('propagates untrustedInput and dispositionTopic (E05-sweep S1 — the containment flag must survive submit)', () => {
    const flagged = buildJobFromSubmit({
      directory: '/work', prompt: 'go', tier: 'trusted',
      untrustedInput: true, dispositionTopic: 'architecture/api-design',
    }, 5000, 'id-3')
    expect(flagged.untrustedInput).toBe(true)
    expect(flagged.dispositionTopic).toBe('architecture/api-design')

    // Absent flag stays undefined (not false/null) so containmentBlock only
    // degrades when explicitly marked untrusted.
    const plain = buildJobFromSubmit({ directory: '/work', prompt: 'go' }, 5000, 'id-4')
    expect(plain.untrustedInput).toBeUndefined()
  })
})
