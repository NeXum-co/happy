import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');

    return React.useMemo(() => {
        if (!data) {
            return data;
        }

        const result: SessionListViewItem[] = [];
        let inactiveCount = 0;

        // First pass: keep the fleet section (needs-you band, project groups,
        // active sessions) and count inactive sessions
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

        // Collapse toggle for inactive sessions ("Earlier (N)")
        if (inactiveCount > 0) {
            result.push({ type: 'archive-toggle', hidden: hideInactiveSessions, count: inactiveCount });
        }

        // If expanded, add the day-grouped inactive sessions
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
    }, [data, hideInactiveSessions]);
}
