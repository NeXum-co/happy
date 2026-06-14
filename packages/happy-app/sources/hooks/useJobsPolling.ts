import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { machineListJobs, type JobRecordView } from '@/sync/runOps';

/**
 * Polls the daemon's autonomous-job list while the screen is focused.
 *
 * Job records live in the daemon's local SQLite store, not in the E2EE relay,
 * so they are not part of the normal sync stream — the only way to observe
 * them from the app is to poll the `list-jobs` machine RPC. We fetch once on
 * focus and then every POLL_INTERVAL_MS, clearing the timer on blur/unmount.
 * Errors are swallowed by machineListJobs (returns []), matching the app's
 * "never show a loading error, just retry" principle. With no machine the
 * hook stays idle and reports an empty list.
 */
const POLL_INTERVAL_MS = 2000;

export function useJobsPolling(machineId: string | null) {
    const [jobs, setJobs] = React.useState<JobRecordView[]>([]);

    useFocusEffect(
        React.useCallback(() => {
            if (!machineId) {
                setJobs([]);
                return;
            }
            let cancelled = false;
            const tick = async () => {
                const next = await machineListJobs(machineId);
                if (!cancelled) {
                    setJobs(next);
                }
            };
            tick();
            const interval = setInterval(tick, POLL_INTERVAL_MS);
            return () => {
                cancelled = true;
                clearInterval(interval);
            };
        }, [machineId]),
    );

    return { jobs };
}
