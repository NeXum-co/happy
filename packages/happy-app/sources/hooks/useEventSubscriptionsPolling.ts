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

    useFocusEffect(
        React.useCallback(() => {
            if (!machineId) {
                setSubscriptions([]);
                return;
            }
            let cancelled = false;
            const tick = async () => {
                const next = await machineListEventSubscriptions(machineId);
                if (!cancelled) {
                    setSubscriptions(next);
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

    return { subscriptions };
}
