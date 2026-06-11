/**
 * `happy fleet` subcommand — machine-readable fleet status (D-E02-9).
 *
 * `happy fleet --waybar` prints exactly one line of JSON for a waybar
 * custom module and always exits 0 (waybar must never get a hanging or
 * failing block).
 *
 * Sessions are fetched via GET /v2/sessions/active with the CLI token and
 * decrypted per session with the persisted encryptionKey from
 * ~/.happy/sessions.json (readPersistedSessions). The normal CLI credential
 * (publicKey+machineKey) cannot open dataKey sessions, so only sessions of
 * THIS machine count — which is the whole single-PC fleet. Sessions without
 * a persisted key are ignored.
 */

import axios from 'axios'

import { decodeBase64, decrypt } from '@/api/encryption'
import type { AgentState } from '@/api/types'
import { LOCAL_REQUEST_TTL_MS } from '@/claude/utils/localAttention'
import { configuration } from '@/configuration'
import { readCredentials, readPersistedSessions } from '@/persistence'

/** Session record as returned by GET /v2/sessions/active (encrypted fields are base64). */
export type RawActiveSession = {
    id: string
    agentState: string | null
}

/** Per-session encryption keys, shape-compatible with readPersistedSessions(). */
export type SessionKeyLookup = Record<string, {
    encryptionKey: string
    encryptionVariant: 'legacy' | 'dataKey'
}>

type WaybarOutput = {
    text: string
    class: 'needs-attention' | 'idle' | 'error'
    tooltip: string
}

/**
 * Count sessions that are waiting on the user: sessions whose decrypted
 * agentState has at least one open permission request — remote-driven
 * (`requests`) or a local terminal prompt (`localRequest`, E02 AC-6). A
 * session with both counts once. Sessions without a persisted key, without
 * agentState, or that fail to decrypt are ignored. A localRequest older than
 * LOCAL_REQUEST_TTL_MS is ignored too (D-E02-13): an interactive deny in the
 * Claude TUI fires no hook event, so the signal can go stale.
 */
export function countNeedsAttention(sessions: RawActiveSession[], keys: SessionKeyLookup, now: number = Date.now()): number {
    let count = 0
    for (const session of sessions) {
        const persisted = keys[session.id]
        if (!persisted || !session.agentState) {
            continue
        }
        const agentState = decrypt(
            decodeBase64(persisted.encryptionKey),
            persisted.encryptionVariant,
            decodeBase64(session.agentState),
        ) as AgentState | null
        const hasRemoteRequests = !!(agentState?.requests && Object.keys(agentState.requests).length > 0)
        const hasFreshLocalRequest = !!agentState?.localRequest
            && now - agentState.localRequest.createdAt <= LOCAL_REQUEST_TTL_MS
        if (hasRemoteRequests || hasFreshLocalRequest) {
            count++
        }
    }
    return count
}

async function buildWaybarOutput(): Promise<WaybarOutput> {
    const credentials = await readCredentials()
    if (!credentials) {
        return { text: '!', class: 'error', tooltip: 'Fleet: not authenticated — run `happy auth login`' }
    }

    const response = await axios.get(`${configuration.serverUrl}/v2/sessions/active`, {
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': `cli-fleet/${configuration.currentCliVersion}`,
        },
        timeout: 5000,
    })
    const sessions = (response.data as { sessions: RawActiveSession[] }).sessions
    const count = countNeedsAttention(sessions, readPersistedSessions())

    if (count > 0) {
        return {
            text: String(count),
            class: 'needs-attention',
            tooltip: count === 1 ? '1 sessie wacht op jou' : `${count} sessies wachten op jou`,
        }
    }
    return { text: '', class: 'idle', tooltip: 'Fleet OK' }
}

/**
 * Entry point for `happy fleet`. Always exits the process with code 0.
 */
export async function runFleetCommand(args: string[]): Promise<void> {
    if (!args.includes('--waybar')) {
        console.log(`
happy fleet - Fleet status

Usage:
  happy fleet --waybar    Print one line of waybar JSON (custom module, return-type json)
`)
        process.exit(0)
    }

    let output: WaybarOutput
    try {
        output = await buildWaybarOutput()
    } catch (error) {
        // AxiosError wraps ECONNREFUSED in an AggregateError with an empty
        // message; fall back to the error code so the tooltip stays useful.
        let reason = error instanceof Error ? error.message : ''
        if (!reason && error && typeof error === 'object' && 'code' in error) {
            reason = String((error as { code?: string }).code ?? '')
        }
        output = { text: '!', class: 'error', tooltip: `Fleet: ${reason || 'relay unreachable'}` }
    }

    // Flush before exiting — process.exit() can drop buffered stdout on pipes.
    await new Promise<void>((resolve) => {
        process.stdout.write(JSON.stringify(output) + '\n', () => resolve())
    })
    process.exit(0)
}
