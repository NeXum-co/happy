/**
 * Unit tests for failure classification, exponential backoff, and retry logic.
 */

import { describe, it, expect } from 'vitest'
import { classifyFailure, backoffMs, shouldRetry } from './retry'

describe('classifyFailure', () => {
    it('classifies 429 as transient', () => {
        expect(classifyFailure({ status: 429 })).toBe('transient')
    })

    it('classifies 400 as permanent', () => {
        expect(classifyFailure({ status: 400 })).toBe('permanent')
    })

    it('classifies 401 as permanent', () => {
        expect(classifyFailure({ status: 401 })).toBe('permanent')
    })

    it('classifies 404 as permanent', () => {
        expect(classifyFailure({ status: 404 })).toBe('permanent')
    })

    it('classifies 503 as transient', () => {
        expect(classifyFailure({ status: 503 })).toBe('transient')
    })

    it('classifies 500 as transient', () => {
        expect(classifyFailure({ status: 500 })).toBe('transient')
    })

    it('classifies message containing "timeout" (case-insensitive) as transient', () => {
        expect(classifyFailure({ message: 'Read timeout' })).toBe('transient')
        expect(classifyFailure({ message: 'TIMEOUT occurred' })).toBe('transient')
        expect(classifyFailure({ message: 'connection timed out' })).toBe('transient')
    })

    it('classifies error with no status as transient', () => {
        expect(classifyFailure({ message: 'network error' })).toBe('transient')
        expect(classifyFailure({})).toBe('transient')
    })
})

describe('backoffMs', () => {
    it('returns initial value at attempt 0 with zero jitter', () => {
        expect(backoffMs(0, { rand: () => 0 })).toBe(1000)
    })

    it('returns initial * coefficient^attempt at attempt 3', () => {
        // 1000 * 2^3 = 8000, jitter = 0
        expect(backoffMs(3, { rand: () => 0 })).toBe(8000)
    })

    it('is capped at maxMs', () => {
        // 1000 * 2^100 is enormous, must be capped at 300000
        expect(backoffMs(100, { rand: () => 0 })).toBe(300000)
    })

    it('applies jitter proportionally', () => {
        // At attempt 0 with rand()=0.5: 1000 + 0.5*1000 = 1500
        expect(backoffMs(0, { rand: () => 0.5 })).toBe(1500)
    })

    it('respects custom initial, coefficient, and maxMs', () => {
        // initial=500, coefficient=3, attempt=2: 500 * 9 = 4500, jitter=0
        expect(backoffMs(2, { initial: 500, coefficient: 3, maxMs: 10000, rand: () => 0 })).toBe(4500)
    })
})

describe('shouldRetry', () => {
    it('returns true for transient error within max attempts', () => {
        expect(shouldRetry(2, 5, 'transient')).toBe(true)
    })

    it('returns false when attempt equals maxAttempts (transient)', () => {
        expect(shouldRetry(5, 5, 'transient')).toBe(false)
    })

    it('returns false for permanent errors regardless of attempt count', () => {
        expect(shouldRetry(0, 5, 'permanent')).toBe(false)
        expect(shouldRetry(1, 5, 'permanent')).toBe(false)
    })
})
