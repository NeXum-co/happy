/**
 * Unit tests for fleet status counting (waybar integration)
 *
 * Uses real encryption (no mocks): agentState blobs are encrypted with
 * encryptWithDataKey exactly like a live session would persist them.
 */
import { describe, expect, it } from 'vitest'

import { encodeBase64, encryptWithDataKey, getRandomBytes } from '@/api/encryption'
import type { AgentState } from '@/api/types'
import { countNeedsAttention, type RawActiveSession, type SessionKeyLookup } from './fleetStatus'

function makeSession(id: string, agentState: AgentState | null, key: Uint8Array): RawActiveSession {
    return {
        id,
        agentState: agentState ? encodeBase64(encryptWithDataKey(agentState, key)) : null,
    }
}

function makeKeys(entries: Array<{ id: string, key: Uint8Array }>): SessionKeyLookup {
    const keys: SessionKeyLookup = {}
    for (const entry of entries) {
        keys[entry.id] = {
            encryptionKey: encodeBase64(entry.key),
            encryptionVariant: 'dataKey',
        }
    }
    return keys
}

const pendingRequest: AgentState = {
    requests: {
        'req-1': { tool: 'Bash', arguments: { command: 'ls -la' }, createdAt: Date.now() },
    },
}

describe('countNeedsAttention', () => {
    it('returns 0 for an empty fleet', () => {
        expect(countNeedsAttention([], {})).toBe(0)
    })

    it('counts every session with pending permission requests', () => {
        const keyA = getRandomBytes(32)
        const keyB = getRandomBytes(32)
        const sessions = [
            makeSession('session-a', pendingRequest, keyA),
            makeSession('session-b', pendingRequest, keyB),
        ]
        const keys = makeKeys([{ id: 'session-a', key: keyA }, { id: 'session-b', key: keyB }])

        expect(countNeedsAttention(sessions, keys)).toBe(2)
    })

    it('does not count sessions whose requests object is empty', () => {
        const key = getRandomBytes(32)
        const sessions = [makeSession('session-a', { requests: {} }, key)]
        const keys = makeKeys([{ id: 'session-a', key }])

        expect(countNeedsAttention(sessions, keys)).toBe(0)
    })

    it('does not count sessions with a null agentState', () => {
        const key = getRandomBytes(32)
        const sessions = [makeSession('session-a', null, key)]
        const keys = makeKeys([{ id: 'session-a', key }])

        expect(countNeedsAttention(sessions, keys)).toBe(0)
    })

    it('ignores sessions without a persisted key (other machines)', () => {
        const key = getRandomBytes(32)
        // Session has pending requests, but we have no key for it
        const sessions = [makeSession('foreign-session', pendingRequest, key)]

        expect(countNeedsAttention(sessions, {})).toBe(0)
    })

    it('ignores sessions whose blob does not decrypt with our key', () => {
        const realKey = getRandomBytes(32)
        const wrongKey = getRandomBytes(32)
        const sessions = [makeSession('session-a', pendingRequest, realKey)]
        const keys = makeKeys([{ id: 'session-a', key: wrongKey }])

        expect(countNeedsAttention(sessions, keys)).toBe(0)
    })

    it('counts a session with only a local terminal prompt (localRequest, AC-6)', () => {
        const key = getRandomBytes(32)
        const localOnly: AgentState = {
            localRequest: { message: 'Claude needs your permission to use Bash', createdAt: Date.now() },
        }
        const sessions = [makeSession('session-a', localOnly, key)]
        const keys = makeKeys([{ id: 'session-a', key }])

        expect(countNeedsAttention(sessions, keys)).toBe(1)
    })

    it('counts a session with both remote requests and a localRequest exactly once', () => {
        const key = getRandomBytes(32)
        const both: AgentState = {
            ...pendingRequest,
            localRequest: { message: 'Permission required', createdAt: Date.now() },
        }
        const sessions = [makeSession('session-a', both, key)]
        const keys = makeKeys([{ id: 'session-a', key }])

        expect(countNeedsAttention(sessions, keys)).toBe(1)
    })

    it('does not count a cleared (null) localRequest', () => {
        const key = getRandomBytes(32)
        const cleared: AgentState = { localRequest: null, requests: {} }
        const sessions = [makeSession('session-a', cleared, key)]
        const keys = makeKeys([{ id: 'session-a', key }])

        expect(countNeedsAttention(sessions, keys)).toBe(0)
    })
})
