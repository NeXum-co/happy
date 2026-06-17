import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';
import { collapseInactiveSessions } from '@/sync/collapseInactiveSessions';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');

    return React.useMemo(
        () => (data ? collapseInactiveSessions(data, hideInactiveSessions) : data),
        [data, hideInactiveSessions],
    );
}
