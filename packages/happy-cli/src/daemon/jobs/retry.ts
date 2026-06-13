/**
 * Failure classification, exponential backoff, and retry decision logic
 * for the autonomous job layer.
 *
 * Classification rules:
 *  - status 429 or 500-599 → 'transient'
 *  - message containing 'timeout' (case-insensitive) or no status → 'transient'
 *  - status 400-499 (except 429) → 'permanent'
 *
 * Backoff: min(maxMs, initial * coefficient^attempt) + jitter(rand() * baseValue)
 */

export type FailureClass = 'transient' | 'permanent'

/**
 * Classifies an error as transient (worth retrying) or permanent (not worth retrying).
 */
export function classifyFailure(err: { status?: number; message?: string }): FailureClass {
    const { status, message } = err

    if (status === undefined) {
        return 'transient'
    }

    if (status === 429) {
        return 'transient'
    }

    if (status >= 500 && status <= 599) {
        return 'transient'
    }

    if (status >= 400 && status <= 499) {
        // Check message for timeout even in 4xx range, but spec says 4xx (except 429) = permanent
        // timeout-in-message check applies when there is NO status (handled above).
        // So here: 4xx that are not 429 → permanent.
        return 'permanent'
    }

    // For any other status (1xx, 2xx, 3xx) or message-only timeout, check message
    if (message && /timeout/i.test(message)) {
        return 'transient'
    }

    return 'transient'
}

interface BackoffOptions {
    initial?: number
    coefficient?: number
    maxMs?: number
    rand?: () => number
}

/**
 * Computes the next backoff delay in milliseconds.
 * Formula: min(maxMs, initial * coefficient^attempt) + rand() * min(maxMs, initial * coefficient^attempt)
 */
export function backoffMs(attempt: number, opts?: BackoffOptions): number {
    const initial = opts?.initial ?? 1000
    const coefficient = opts?.coefficient ?? 2
    const maxMs = opts?.maxMs ?? 300_000
    const rand = opts?.rand ?? Math.random

    const base = Math.min(maxMs, initial * Math.pow(coefficient, attempt))
    return base + rand() * base
}

/**
 * Returns true if another retry attempt should be made.
 * Permanent failures are never retried. Transient failures are retried
 * while attempt < maxAttempts.
 */
export function shouldRetry(attempt: number, maxAttempts: number, cls: FailureClass): boolean {
    if (cls === 'permanent') {
        return false
    }
    return attempt < maxAttempts
}
