import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { machineListEventSubscriptions, type EventSubscriptionView } from '@/sync/eventOps';

/**
 * Polls the daemon's event-subscription list while the screen is focused.
 *
 * Event subscriptions live in the daemon's local SQLite store, not in the E2EE
 * relay, so they are not part of the normal sync stream — the only way to observe
 * them from the app is to poll the `list-event-subscriptions` machine RPC. We
 * fetch once on focus and then every POLL_INTERVAL_MS, clearing the timer on
 * blur/unmount. Errors are swallowed by machineListEventSubscriptions (returns
 * []), matching the app's "never show a loading error, just retry" principle.
 * With no machine the hook stays idle and reports an empty list.
 */
const POLL_INTERVAL_MS = 2000;

export function useEventSubscriptionsPolling(machineId: string | null) {
    const [subscriptions, setSubscriptions] = React.useState<EventSubscriptionView[]>([]);
    const [loading, setLoading] = React.useState(false);

    useFocusEffect(
        React.useCallback(() => {
            if (!machineId) {
                setSubscriptions([]);
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
                    const next = await machineListEventSubscriptions(machineId);
                    if (!cancelled) {
                        setSubscriptions(next);
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

    return { subscriptions, loading };
}
