/**
 * Unit tests for the lifecycle reaper decision logic.
 *
 * shouldArchive only archives a session the server still claims is active when
 * it is provably gone. Liveness is corroborated with the session's heartbeat
 * (activeAt): a recently-active session is alive even if metadata carries a
 * stale host PID (F2), and a session that stopped heartbeating is gone even if
 * its old PID now looks alive through OS PID reuse (F1).
 */

import { describe, it, expect } from 'vitest'
import { shouldArchive } from './reaper'

describe('shouldArchive', () => {
  const dead = (_pid: number) => false
  const alive = (_pid: number) => true
  const NOW = 10_000_000
  const fresh = NOW - 5_000        // < grace (30s) → heartbeating
  const settled = NOW - 60_000     // > grace, < stale → pid is the authority
  const longStale = NOW - 200_000  // > stale (2 min) → no heartbeat for too long

  it('archives a server-active session whose host process is dead', () => {
    expect(shouldArchive({ serverActive: true, hostPid: 1234, activeAt: settled }, dead, NOW)).toBe(true)
  })

  it('keeps a server-active session whose host process is alive', () => {
    expect(shouldArchive({ serverActive: true, hostPid: 1234, activeAt: settled }, alive, NOW)).toBe(false)
  })

  it('ignores sessions the server already marks inactive', () => {
    expect(shouldArchive({ serverActive: false, hostPid: 1234, activeAt: longStale }, dead, NOW)).toBe(false)
  })

  it('never guesses when no host pid is known', () => {
    expect(shouldArchive({ serverActive: true, activeAt: longStale }, dead, NOW)).toBe(false)
  })

  // F2: a resumed-in-place session reuses the happySessionId; for a brief window
  // the server still serves the PRE-resume metadata (old, now-dead hostPid) while
  // the new host process is alive and heartbeating. A fresh activeAt means alive —
  // never archive on a stale metadata PID.
  it('keeps a freshly-heartbeating session even when its metadata hostPid is dead', () => {
    expect(shouldArchive({ serverActive: true, hostPid: 1234, activeAt: fresh }, dead, NOW)).toBe(false)
  })

  // F1: a dead session stops heartbeating, but the OS can reassign its PID to an
  // unrelated live process, so the PID probe wrongly reports "alive". A long-stale
  // activeAt is the safety net: archive even though the (reused) PID looks alive.
  it('archives a long-stale session even when its (reused) pid looks alive', () => {
    expect(shouldArchive({ serverActive: true, hostPid: 1234, activeAt: longStale }, alive, NOW)).toBe(true)
  })
})
