/**
 * Unit tests for the job status state machine.
 *
 * canTransition reports whether a status edge is legal; assertTransition turns
 * an illegal edge into a thrown error. 'running' may only reach a terminal
 * 'dead' state via 'failed', never directly.
 */

import { describe, it, expect } from 'vitest'
import { canTransition, assertTransition } from './stateMachine'

describe('stateMachine', () => {
  it('allows pending -> running', () => {
    expect(canTransition('pending', 'running')).toBe(true)
  })

  it('forbids succeeded -> running (terminal state)', () => {
    expect(canTransition('succeeded', 'running')).toBe(false)
  })

  it('throws on the illegal running -> dead transition', () => {
    expect(() => assertTransition('running', 'dead')).toThrow()
  })
})
