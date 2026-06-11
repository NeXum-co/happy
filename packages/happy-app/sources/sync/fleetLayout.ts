import { projectKeyFromPath } from './projectKey';

/**
 * Minimal session shape needed to compute the fleet list layout.
 * Kept free of storage/platform imports so the ordering rules are unit-testable.
 */
export interface FleetSessionLike {
    id: string;
    active: boolean;
    activeAt: number;
    createdAt: number;
    needsYou: boolean;
    path: string | null;
    homeDir: string | null;
}

export interface FleetProjectGroup<S extends FleetSessionLike> {
    key: string;
    sessions: S[];
}

/**
 * Why a session needs the user, derived from its agentState:
 * - `remote`: open remote-driven permission requests (`agentState.requests`)
 * - `local`: a terminal permission prompt (`agentState.localRequest`, AC-6) —
 *   the answer has to be given in the terminal, not in the app.
 * Shared by the needs-you predicate and the `permission_required` row state.
 */
export interface AgentAttention {
    remote: boolean;
    local: boolean;
}

/**
 * A localRequest older than this is ignored (D-E02-13): an interactive deny
 * in the Claude TUI fires no hook event, so the CLI cannot always clear the
 * signal — without a TTL such a session would stay "needs you" forever.
 * Keep in sync with happy-cli localAttention.ts (can't be shared: separate
 * packages, fork-diff).
 */
export const LOCAL_REQUEST_TTL_MS = 30 * 60 * 1000;

export function computeAgentAttention(agentState: {
    requests?: Record<string, unknown> | null;
    localRequest?: { message: string; createdAt: number } | null;
} | null | undefined, now: number = Date.now()): AgentAttention {
    return {
        remote: !!(agentState?.requests && Object.keys(agentState.requests).length > 0),
        local: !!agentState?.localRequest && now - agentState.localRequest.createdAt <= LOCAL_REQUEST_TTL_MS,
    };
}

export interface FleetLayout<S extends FleetSessionLike> {
    needsYou: S[];
    projectGroups: FleetProjectGroup<S>[];
    inactive: S[];
}

/**
 * Fleet list ordering (E02):
 * 1. needs-you band — all active sessions waiting on the user, across all
 *    projects, most recent activity first.
 * 2. Remaining active sessions grouped per project key; groups ordered by
 *    their most recent activity, sessions within a group likewise.
 * 3. Inactive sessions, newest created first (feeds the existing
 *    day-grouping).
 */
export function computeFleetLayout<S extends FleetSessionLike>(sessions: S[]): FleetLayout<S> {
    const needsYou: S[] = [];
    const activeRest: S[] = [];
    const inactive: S[] = [];

    for (const session of sessions) {
        if (!session.active) {
            inactive.push(session);
        } else if (session.needsYou) {
            needsYou.push(session);
        } else {
            activeRest.push(session);
        }
    }

    needsYou.sort((a, b) => b.activeAt - a.activeAt);
    inactive.sort((a, b) => b.createdAt - a.createdAt);

    const byProject = new Map<string, S[]>();
    for (const session of activeRest) {
        const key = session.path ? projectKeyFromPath(session.path, session.homeDir) : '';
        const group = byProject.get(key);
        if (group) {
            group.push(session);
        } else {
            byProject.set(key, [session]);
        }
    }

    const projectGroups: FleetProjectGroup<S>[] = Array.from(byProject.entries()).map(([key, group]) => {
        group.sort((a, b) => b.activeAt - a.activeAt);
        return { key, sessions: group };
    });
    projectGroups.sort((a, b) => (b.sessions[0]?.activeAt ?? 0) - (a.sessions[0]?.activeAt ?? 0));

    return { needsYou, projectGroups, inactive };
}
