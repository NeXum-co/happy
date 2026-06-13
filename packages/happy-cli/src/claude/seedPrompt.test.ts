/**
 * Unit tests for the autonomous seed-prompt decision logic.
 *
 * seedFirstMessage: returns the env-supplied prompt only on the first call of a
 * session (alreadySeeded=false) and only when a non-empty value is present.
 */

import { describe, it, expect } from 'vitest'
import { seedFirstMessage } from './seedPrompt'

describe('seedFirstMessage', () => {
  it('returns the prompt on first injection', () => {
    expect(seedFirstMessage('build the report', false)).toBe('build the report')
  })

  it('returns null once already seeded', () => {
    expect(seedFirstMessage('build the report', true)).toBe(null)
  })

  it('returns null when the env value is undefined', () => {
    expect(seedFirstMessage(undefined, false)).toBe(null)
  })

  it('returns null when the env value is empty', () => {
    expect(seedFirstMessage('', false)).toBe(null)
  })
})
