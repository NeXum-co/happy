/**
 * Unit tests for the hook server's shared-secret check (SEC-001).
 *
 * The server only accepts hook POSTs that carry the per-session secret in
 * the X-Hook-Secret header — any same-user process can reach the localhost
 * port, so without the secret it could fake permission prompts or clears.
 * The SessionStart flow (claudeSessionId capture) must keep working with a
 * correct secret.
 */

import { describe, it, expect, afterEach } from 'vitest'

import { startHookServer, type HookServer, type SessionHookData } from './startHookServer'

const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

async function post(port: number, path: string, body: unknown, secret?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(secret !== undefined ? { 'X-Hook-Secret': secret } : {}),
        },
        body: JSON.stringify(body),
    })
}

describe('startHookServer secret check (SEC-001)', () => {
    let server: HookServer | null = null

    afterEach(() => {
        server?.stop()
        server = null
    })

    it('rejects a session-start hook without a secret header with 401 and does not invoke the callback', async () => {
        const received: string[] = []
        server = await startHookServer({
            secret: SECRET,
            onSessionHook: (sessionId) => { received.push(sessionId) },
        })

        const res = await post(server.port, '/hook/session-start', { session_id: 'abc' })

        expect(res.status).toBe(401)
        expect(received).toEqual([])
    })

    it('rejects a session-start hook with a wrong secret with 401 and does not invoke the callback', async () => {
        const received: string[] = []
        server = await startHookServer({
            secret: SECRET,
            onSessionHook: (sessionId) => { received.push(sessionId) },
        })

        const res = await post(server.port, '/hook/session-start', { session_id: 'abc' }, 'wrong-secret')

        expect(res.status).toBe(401)
        expect(received).toEqual([])
    })

    it('accepts a session-start hook with the correct secret (claudeSessionId capture keeps working)', async () => {
        const received: Array<{ sessionId: string, data: SessionHookData }> = []
        server = await startHookServer({
            secret: SECRET,
            onSessionHook: (sessionId, data) => { received.push({ sessionId, data }) },
        })

        const res = await post(server.port, '/hook/session-start', {
            session_id: 'abc-123',
            hook_event_name: 'SessionStart',
            source: 'startup',
        }, SECRET)

        expect(res.status).toBe(200)
        expect(received).toHaveLength(1)
        expect(received[0].sessionId).toBe('abc-123')
        expect(received[0].data.source).toBe('startup')
    })

    it('rejects /hook/event without the secret and accepts it with the secret', async () => {
        const notifications: string[] = []
        const clears: string[] = []
        server = await startHookServer({
            secret: SECRET,
            onSessionHook: () => {},
            onNotification: (message) => { notifications.push(message) },
            onClearSignal: (eventName) => { clears.push(eventName) },
        })

        const rejected = await post(server.port, '/hook/event', {
            hook_event_name: 'Notification',
            message: 'Claude needs your permission to use Bash',
        })
        expect(rejected.status).toBe(401)
        expect(notifications).toEqual([])

        const accepted = await post(server.port, '/hook/event', {
            hook_event_name: 'Notification',
            message: 'Claude needs your permission to use Bash',
        }, SECRET)
        expect(accepted.status).toBe(200)
        expect(notifications).toEqual(['Claude needs your permission to use Bash'])

        const cleared = await post(server.port, '/hook/event', { hook_event_name: 'PostToolUse' }, SECRET)
        expect(cleared.status).toBe(200)
        expect(clears).toEqual(['PostToolUse'])
    })
})
