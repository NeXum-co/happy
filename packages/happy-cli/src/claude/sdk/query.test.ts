/**
 * Unit tests for buildSdkOptions — the pure QueryOptions -> SDK Options mapper.
 *
 * Focus: the bypassPermissions companion flag (allowDangerouslySkipPermissions),
 * which the SDK requires whenever permissionMode is 'bypassPermissions'.
 */

import { describe, it, expect } from 'vitest'
import { buildSdkOptions } from './query'

describe('buildSdkOptions', () => {
  it('sets allowDangerouslySkipPermissions when permissionMode is bypassPermissions', () => {
    expect(buildSdkOptions({ permissionMode: 'bypassPermissions' }).allowDangerouslySkipPermissions).toBe(true)
  })

  it('does not set allowDangerouslySkipPermissions for default mode', () => {
    expect(buildSdkOptions({ permissionMode: 'default' }).allowDangerouslySkipPermissions).toBeFalsy()
  })

  it('does not set allowDangerouslySkipPermissions when options are undefined', () => {
    expect(buildSdkOptions(undefined).allowDangerouslySkipPermissions).toBeFalsy()
  })

  it('passes through maxBudgetUsd and maxTurns', () => {
    const opts = buildSdkOptions({ maxBudgetUsd: 5, maxTurns: 12 })
    expect(opts.maxBudgetUsd).toBe(5)
    expect(opts.maxTurns).toBe(12)
  })
})
