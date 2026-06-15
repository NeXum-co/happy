import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { machineListCrons, type CronScheduleView } from '@/sync/cronOps';

/**
 * Polls the daemon's cron-schedule list while the screen is focused.
 *
 * Cron schedules live in the daemon's local SQLite store, not in the E2EE relay,
 * so they are not part of the normal sync stream — the only way to observe
 * them from the app is to poll the `list-crons` machine RPC. We fetch once on
 * focus and then every POLL_INTERVAL_MS, clearing the timer on blur/unmount.
 * Errors are swallowed by machineListCrons (returns []), matching the app's
 * "never show a loading error, just retry" principle. With no machine the
 * hook stays idle and reports an empty list.
 */
const POLL_INTERVAL_MS = 2000;

export function useCronsPolling(machineId: string | null) {
    const [crons, setCrons] = React.useState<CronScheduleView[]>([]);
    const [loading, setLoading] = React.useState(false);

    useFocusEffect(
        React.useCallback(() => {
            if (!machineId) {
                setCrons([]);
                setLoading(false);
                return;
            }
            let cancelled = false;
            let inFlight = false;
            setLoading(true);
            const tick = async () => {
                // PERF-5: skip this tick if the previous RPC is still pending so a
                // slow request can't let overlapping fetches stack up.
                if (inFlight) {
                    return;
                }
                inFlight = true;
                try {
                    const next = await machineListCrons(machineId);
                    if (!cancelled) {
                        setCrons(next);
                    }
                } finally {
                    inFlight = false;
                    if (!cancelled) {
                        setLoading(false);
                    }
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

    return { crons, loading };
}
