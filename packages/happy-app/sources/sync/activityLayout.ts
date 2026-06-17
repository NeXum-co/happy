/**
 * Minimal session shape needed to compute the activity-dashboard layout.
 * Kept free of storage/platform imports (no React/RN) so the grouping and
 * aggregation rules are unit-testable, mirroring fleetLayout.ts.
 *
 * This is a subset of the RAW `Session` type (storageTypes.ts): on the raw
 * type `activeAt` is always present, unlike `SessionRowData` which only
 * exposes it for inactive sessions.
 */
export interface ActivitySessionLike {
    id: string;
    createdAt: number;
    active: boolean;
    activeAt: number;
    metadata: {
        path?: string;
        machineId?: string;
    } | null;
}

export interface ActivityRow {
    id: string;
    title: string;
    project: string | null;
    machineId: string | null;
    createdAt: number;
    durationMs: number;
    active: boolean;
    costUsd?: number;
    isAutonomous: boolean;
}

export interface DayGroup {
    date: string;
    sessions: ActivityRow[];
    totals: { count: number; durationMs: number; costUsd: number };
}

export interface ProjectRollupRow {
    machineId: string | null;
    project: string | null;
    count: number;
    durationMs: number;
    costUsd: number;
    lastActiveAt: number;
}

export interface ActivityLayout {
    dayGroups: DayGroup[];
    projectRollup: ProjectRollupRow[];
}

export interface ActivityLayoutOptions {
    /** Per-session cost in USD, keyed by `session.id`. */
    usageBySession?: Map<string, number>;
    /** Reference time for the duration of still-active sessions. */
    now: number;
    /**
     * Resolves a session title. The production caller passes
     * `getSessionName`; it lives in opts because that helper pulls in
     * platform code (i18n/expo) which must stay out of this pure module.
     */
    getTitle?: (session: ActivitySessionLike) => string;
}

/**
 * Local calendar day (YYYY-MM-DD) of a timestamp, used as the day-group key.
 */
function dayKey(timestamp: number): string {
    const d = new Date(timestamp);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Activity-dashboard layout (E08):
 * - rows grouped by local calendar day of `createdAt`, days newest first,
 *   sessions within a day newest-created first;
 * - duration = (active ? now : activeAt) - createdAt, clamped to >= 0 and
 *   guarded against NaN;
 * - project rollup aggregates rows by the (machineId, project) pair.
 */
export function computeActivityLayout(
    sessions: ActivitySessionLike[],
    opts: ActivityLayoutOptions,
): ActivityLayout {
    const { usageBySession, now, getTitle } = opts;

    const rows: ActivityRow[] = sessions.map((session) => {
        const project = session.metadata?.path ?? null;
        const machineId = session.metadata?.machineId ?? null;
        const endAt = session.active ? now : session.activeAt;
        const rawDuration = endAt - session.createdAt;
        const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
        const costUsd = usageBySession?.get(session.id);

        return {
            id: session.id,
            title: getTitle ? getTitle(session) : '',
            project,
            machineId,
            createdAt: session.createdAt,
            durationMs,
            active: session.active,
            costUsd,
            isAutonomous: false,
        };
    });

    const byDay = new Map<string, ActivityRow[]>();
    for (const row of rows) {
        const key = dayKey(row.createdAt);
        const bucket = byDay.get(key);
        if (bucket) {
            bucket.push(row);
        } else {
            byDay.set(key, [row]);
        }
    }

    const dayGroups: DayGroup[] = Array.from(byDay.entries()).map(([date, daySessions]) => {
        daySessions.sort((a, b) => b.createdAt - a.createdAt);
        const totals = daySessions.reduce(
            (acc, row) => {
                acc.count += 1;
                acc.durationMs += row.durationMs;
                acc.costUsd += row.costUsd ?? 0;
                return acc;
            },
            { count: 0, durationMs: 0, costUsd: 0 },
        );
        return { date, sessions: daySessions, totals };
    });
    dayGroups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const byProject = new Map<string, ProjectRollupRow>();
    for (const row of rows) {
        // JSON-encode the (machineId, project) pair so a `:` inside a path or a
        // null component can't make two distinct buckets collide.
        const key = JSON.stringify([row.machineId, row.project]);
        // Effective last-active time = end of the session (now for active, activeAt
        // for inactive), which equals createdAt + durationMs after the clamp above.
        const rowLastActiveAt = row.createdAt + row.durationMs;
        const existing = byProject.get(key);
        if (existing) {
            existing.count += 1;
            existing.durationMs += row.durationMs;
            existing.costUsd += row.costUsd ?? 0;
            existing.lastActiveAt = Math.max(existing.lastActiveAt, rowLastActiveAt);
        } else {
            byProject.set(key, {
                machineId: row.machineId,
                project: row.project,
                count: 1,
                durationMs: row.durationMs,
                costUsd: row.costUsd ?? 0,
                lastActiveAt: rowLastActiveAt,
            });
        }
    }

    return { dayGroups, projectRollup: Array.from(byProject.values()) };
}
