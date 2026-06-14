/**
 * Unit tests for the autonomous seed-prompt decision logic.
 *
 * seedFirstMessage: returns the env-supplied prompt only on the first call of a
 * session (alreadySeeded=false) and only when a non-empty value is present.
 */

import { describe, it, expect } from 'vitest'
import { seedFirstMessage, resolveSeedMode } from './seedPrompt'

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

describe('resolveSeedMode', () => {
  it('maps a TRUSTED job to bypassPermissions without allowedTools', () => {
    expect(resolveSeedMode({ HAPPY_JOB_PERMISSION_MODE: 'bypassPermissions' })).toEqual({
      permissionMode: 'bypassPermissions',
    })
  })

  it('maps a SUPERVISED job to default with the allowed-tools CSV', () => {
    expect(
      resolveSeedMode({ HAPPY_JOB_PERMISSION_MODE: 'default', HAPPY_JOB_ALLOWED_TOOLS: 'Read,Grep' })
    ).toEqual({ permissionMode: 'default', allowedTools: ['Read', 'Grep'] })
  })

  it('defaults to default mode with no override when the env is absent', () => {
    expect(resolveSeedMode({})).toEqual({ permissionMode: 'default' })
  })

  it('carries allowedTools through for a TRUSTED job when present', () => {
    expect(
      resolveSeedMode({ HAPPY_JOB_PERMISSION_MODE: 'bypassPermissions', HAPPY_JOB_ALLOWED_TOOLS: 'Bash' })
    ).toEqual({ permissionMode: 'bypassPermissions', allowedTools: ['Bash'] })
  })

  it('trims whitespace and drops empty entries in the CSV', () => {
    expect(
      resolveSeedMode({ HAPPY_JOB_PERMISSION_MODE: 'default', HAPPY_JOB_ALLOWED_TOOLS: ' Read , , Grep ,' })
    ).toEqual({ permissionMode: 'default', allowedTools: ['Read', 'Grep'] })
  })
})
