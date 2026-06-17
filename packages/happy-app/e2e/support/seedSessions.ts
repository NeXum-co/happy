// Deterministic session seeding for the isolated-relay fleet web-E2E (E10 Slice C).
//
// Creates a documented set of sessions on the isolated relay so the rich fleet specs can assert the
// fleet layout precisely (needs-you band, project groups, local-attention, "Earlier (N)" archive):
//
//   - alpha-needs-you   project 'alpha', active, REMOTE permission request   -> needs-you band
//   - alpha-local       project 'alpha', active, LOCAL terminal prompt (AC-6) -> needs-you (terminal)
//   - beta-idle         project 'beta',  active, no attention                 -> 'beta' project group
//   - earlier-one       project 'alpha', archived (active:false)              -> Earlier (collapsed)
//   - earlier-two       project 'beta',  archived (active:false)              -> Earlier (collapsed)
//
// Project key derives from metadata.path relative to `${homeDir}/code/` (projectKey.ts). We use a
// synthetic homeDir so the groups are 'alpha' and 'beta' regardless of the host. The needs-you band
// requires the session to be online (presence) AND have attention — fresh sessions are active/online
// by default; agentState is pushed over a session-scoped socket via the `update-state` event.

import { io } from 'socket.io-client';
import { encLegacy } from './seedAccount';

const HOME_DIR = '/home/e2e';

interface SeedSpec {
    tag: string;
    project: string;
    path: string;
    archive: boolean;
    agentState?: Record<string, unknown>;
}

export interface SeededSession {
    tag: string;
    project: string;
    id: string;
    archived: boolean;
}

export interface SeededFleet {
    homeDir: string;
    sessions: SeededSession[];
    needsYouRemoteTag: string;
    localAttentionTag: string;
    idleTag: string;
    archivedTags: string[];
    projects: string[];
}

const SPECS: SeedSpec[] = [
    {
        tag: 'e2e-alpha-needs-you',
        project: 'alpha',
        path: `${HOME_DIR}/code/alpha/service`,
        archive: false,
        // Remote permission request -> needs-you band (remote).
        agentState: { requests: { 'req-1': { tool: 'Bash', arguments: {}, createdAt: 1 } } },
    },
    {
        tag: 'e2e-alpha-local',
        project: 'alpha',
        path: `${HOME_DIR}/code/alpha/worker`,
        archive: false,
        // Local terminal prompt (AC-6) -> needs-you band, "Waiting in terminal".
        agentState: { localRequest: { message: 'Claude needs your permission to use Bash', createdAt: Date.now() } },
    },
    {
        tag: 'e2e-beta-idle',
        project: 'beta',
        path: `${HOME_DIR}/code/beta/api`,
        archive: false,
        // No attention -> plain active session under the 'beta' project group.
    },
    {
        tag: 'e2e-earlier-one',
        project: 'alpha',
        path: `${HOME_DIR}/code/alpha/legacy`,
        archive: true,
    },
    {
        tag: 'e2e-earlier-two',
        project: 'beta',
        path: `${HOME_DIR}/code/beta/old`,
        archive: true,
    },
];

function metadataFor(spec: SeedSpec) {
    return {
        path: spec.path,
        host: 'e2e-host',
        homeDir: HOME_DIR,
        happyHomeDir: `${HOME_DIR}/.happy`,
        version: '1.0.0-e2e',
        os: 'linux',
    };
}

async function createSession(relayUrl: string, token: string, masterSecret: Uint8Array, spec: SeedSpec): Promise<string> {
    const res = await fetch(`${relayUrl}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ tag: spec.tag, metadata: encLegacy(metadataFor(spec), masterSecret) }),
    });
    if (!res.ok) {
        throw new Error(`seedSessions: create ${spec.tag} failed ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { session: { id: string } };
    return data.session.id;
}

async function pushAgentState(relayUrl: string, token: string, masterSecret: Uint8Array, sessionId: string, agentState: Record<string, unknown>): Promise<void> {
    const socket = io(relayUrl, {
        auth: { token, clientType: 'session-scoped', sessionId, happyClient: 'e2e-seed/0' },
        path: '/v1/updates',
        reconnection: false,
        withCredentials: true,
        transports: ['websocket'],
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`seedSessions: update-state socket timeout for ${sessionId}`)), 10_000);
            socket.on('connect', () => {
                socket.emit('update-state', { sid: sessionId, agentState: encLegacy(agentState, masterSecret), expectedVersion: 0 }, (ack: { result?: string } | undefined) => {
                    clearTimeout(timer);
                    if (ack?.result === 'success') resolve();
                    else reject(new Error(`seedSessions: update-state rejected: ${JSON.stringify(ack)}`));
                });
            });
            socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
        });
    } finally {
        socket.close();
    }
}

async function archiveSession(relayUrl: string, token: string, sessionId: string): Promise<void> {
    const res = await fetch(`${relayUrl}/v1/sessions/${sessionId}/archive`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        throw new Error(`seedSessions: archive ${sessionId} failed ${res.status}: ${await res.text()}`);
    }
}

/** Seed the deterministic fleet on the isolated relay. Returns the shape for precise spec assertions. */
export async function seedSessions(relayUrl: string, token: string, masterSecret: Uint8Array): Promise<SeededFleet> {
    const sessions: SeededSession[] = [];
    for (const spec of SPECS) {
        const id = await createSession(relayUrl, token, masterSecret, spec);
        if (spec.agentState) {
            await pushAgentState(relayUrl, token, masterSecret, id, spec.agentState);
        }
        if (spec.archive) {
            await archiveSession(relayUrl, token, id);
        }
        sessions.push({ tag: spec.tag, project: spec.project, id, archived: spec.archive });
    }

    return {
        homeDir: HOME_DIR,
        sessions,
        needsYouRemoteTag: 'e2e-alpha-needs-you',
        localAttentionTag: 'e2e-alpha-local',
        idleTag: 'e2e-beta-idle',
        archivedTags: ['e2e-earlier-one', 'e2e-earlier-two'],
        projects: ['alpha', 'beta'],
    };
}
