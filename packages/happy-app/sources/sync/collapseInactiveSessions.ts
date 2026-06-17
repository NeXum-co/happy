import type { SessionListViewItem } from './storage';

/**
 * Collapses the inactive sessions of a fleet view into a single "Earlier (N)"
 * archive-toggle. The fleet section (needs-you band, project groups, active
 * sessions) is kept verbatim; inactive sessions are counted and, when expanded,
 * re-appended together with their day headers. Pure — the hook only feeds it the
 * store view-data and the `hideInactiveSessions` setting.
 */
export function collapseInactiveSessions(
    data: SessionListViewItem[],
    hideInactiveSessions: boolean,
): SessionListViewItem[] {
    const result: SessionListViewItem[] = [];
    let inactiveCount = 0;

    // First pass: keep the fleet section and count inactive sessions.
    for (const item of data) {
        if (item.type === 'needs-you' || item.type === 'project-group') {
            result.push(item);
        } else if (item.type === 'session') {
            if (item.session.active) {
                result.push(item);
            } else {
                inactiveCount++;
            }
        }
    }

    if (inactiveCount > 0) {
        result.push({ type: 'archive-toggle', hidden: hideInactiveSessions, count: inactiveCount });
    }

    // When expanded, append the day-grouped inactive sessions.
    if (!hideInactiveSessions) {
        for (const item of data) {
            if (item.type === 'header') {
                result.push(item);
            } else if (item.type === 'session' && !item.session.active) {
                result.push(item);
            }
        }
    }

    return result;
}
