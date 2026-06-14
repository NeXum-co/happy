/**
 * Unit tests for buildJobFromSubmit — the pure submit-job → JobRecord mapping.
 * Verifies defaults (supervised, local-qwen, 5 attempts, no transition state)
 * and optional field propagation (limits, timeout, allowedTools).
 */

import { describe, it, expect } from 'vitest'
import { buildJobFromSubmit } from './scheduler'

describe('buildJobFromSubmit', () => {
  it('applies defaults for a minimal submit', () => {
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
    expect(job.timeoutAt).toBeUndefined()
    expect(job.maxBudgetUsd).toBeUndefined()
    expect(job.maxTurns).toBeUndefined()
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
})
