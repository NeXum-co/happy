/**
 * Unit tests for cronSchedule pure utility functions.
 *
 * Tests cover: validation of cron expressions, occurrence enumeration with
 * inclusive upper / exclusive lower bounds, invalid expression handling.
 */

import { describe, it, expect } from 'vitest'
import { validateCronExpr, occurrencesBetween } from './cronSchedule'

describe('validateCronExpr', () => {
  it('returns true for a valid 5-field cron expression', () => {
    expect(validateCronExpr('*/5 * * * *')).toBe(true)
  })

  it('returns true for a valid exact-time cron expression', () => {
    expect(validateCronExpr('0 * * * *')).toBe(true)
  })

  it('returns false for a nonsense expression', () => {
    expect(validateCronExpr('nonsense')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(validateCronExpr('')).toBe(false)
  })
})

describe('occurrencesBetween', () => {
  const after = Date.UTC(2026, 0, 1, 10, 0, 0)  // 2026-01-01T10:00:00Z
  const now   = Date.UTC(2026, 0, 1, 13, 30, 0) // 2026-01-01T13:30:00Z

  it('returns occurrences in (after, now] for an hourly expression', () => {
    const result = occurrencesBetween('0 * * * *', after, now)
    expect(result).toEqual([
      Date.UTC(2026, 0, 1, 11, 0, 0),
      Date.UTC(2026, 0, 1, 12, 0, 0),
      Date.UTC(2026, 0, 1, 13, 0, 0),
    ])
  })

  it('excludes the lower bound when after is exactly on a boundary', () => {
    // after = 11:00 exactly — that hit should NOT be included, first result is 12:00
    const afterOnBoundary = Date.UTC(2026, 0, 1, 11, 0, 0)
    const result = occurrencesBetween('0 * * * *', afterOnBoundary, now)
    expect(result[0]).toBe(Date.UTC(2026, 0, 1, 12, 0, 0))
    expect(result).not.toContain(Date.UTC(2026, 0, 1, 11, 0, 0))
  })

  it('returns [] for an invalid expression', () => {
    expect(occurrencesBetween('nonsense', after, now)).toEqual([])
  })

  it('returns [] for an empty expression', () => {
    expect(occurrencesBetween('', after, now)).toEqual([])
  })

  it('returns [] when no occurrences fall in the window', () => {
    // Midnight-only expr, window is entirely within the same day afternoon
    const result = occurrencesBetween('0 0 * * *', after, now)
    expect(result).toEqual([])
  })

  it('returns results in ascending order, oldest first', () => {
    const result = occurrencesBetween('0 * * * *', after, now)
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toBeGreaterThan(result[i - 1])
    }
  })
})
