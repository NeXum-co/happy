/**
 * Unit tests for the autonomous seed-prompt decision logic.
 *
 * seedFirstMessage: returns the env-supplied prompt only on the first call of a
 * session (alreadySeeded=false) and only when a non-empty value is present.
 */

import { describe, it, expect } from 'vitest'
import { seedFirstMessage, resolveSeedMode, shouldExitAutonomous } from './seedPrompt'

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

describe('shouldExitAutonomous', () => {
  it('exits once an autonomous session has seeded with nothing pending', () => {
    expect(shouldExitAutonomous(true, true, false)).toBe(true)
  })

  it('does not exit an autonomous session that has not yet seeded', () => {
    expect(shouldExitAutonomous(true, false, false)).toBe(false)
  })

  it('does not exit while a pending message is queued', () => {
    expect(shouldExitAutonomous(true, true, true)).toBe(false)
  })

  it('never exits an interactive (non-autonomous) session', () => {
    expect(shouldExitAutonomous(false, true, false)).toBe(false)
  })
})

describe('resolveSeedMode model pin', () => {
  it('pins the model from HAPPY_JOB_MODEL when set', () => {
    expect(
      resolveSeedMode({ HAPPY_JOB_PERMISSION_MODE: 'default', HAPPY_JOB_MODEL: 'qwen-moe' })
    ).toEqual({ permissionMode: 'default', model: 'qwen-moe' })
  })

  it('omits model when HAPPY_JOB_MODEL is absent', () => {
    expect(resolveSeedMode({ HAPPY_JOB_PERMISSION_MODE: 'bypassPermissions' }))
      .toEqual({ permissionMode: 'bypassPermissions' })
  })
})
