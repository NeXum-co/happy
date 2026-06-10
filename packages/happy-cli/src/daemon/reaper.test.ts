/**
 * Unit tests for the lifecycle reaper decision logic.
 *
 * shouldArchive: a session is only archived when the server still claims it
 * is active, we know its host PID, and that PID no longer exists locally.
 */

import { describe, it, expect } from 'vitest'
import { shouldArchive } from './reaper'

describe('shouldArchive', () => {
  const dead = (_pid: number) => false
  const alive = (_pid: number) => true

  it('archives a server-active session whose host process is dead', () => {
    expect(shouldArchive({ serverActive: true, hostPid: 1234 }, dead)).toBe(true)
  })

  it('keeps a server-active session whose host process is alive', () => {
    expect(shouldArchive({ serverActive: true, hostPid: 1234 }, alive)).toBe(false)
  })

  it('ignores sessions the server already marks inactive', () => {
    expect(shouldArchive({ serverActive: false, hostPid: 1234 }, dead)).toBe(false)
  })

  it('never guesses when no host pid is known', () => {
    expect(shouldArchive({ serverActive: true }, dead)).toBe(false)
  })
})
