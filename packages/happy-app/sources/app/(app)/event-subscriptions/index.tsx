import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines } from '@/sync/storage';
import { useEventSubscriptionsPolling } from '@/hooks/useEventSubscriptionsPolling';
import { machineDeleteEventSubscription, type EventSubscriptionView } from '@/sync/eventOps';
import { useHappyAction } from '@/hooks/useHappyAction';
import { Modal } from '@/modal';
import { t } from '@/text';

// Map an event-subscription tier to its localized label.
function tierLabel(tier: EventSubscriptionView['tier']): string {
    return tier === 'trusted' ? t('event.tierTrusted') : t('event.tierSupervised');
}

function EventSubscriptionRow({ machineId, subscription }: { machineId: string; subscription: EventSubscriptionView }) {
    const { theme } = useUnistyles();

    // useHappyAction provides the double-tap guard (UX-9, in-flight ref) and
    // surfaces a failed delete via Modal.alert (UX-1) instead of swallowing it.
    const [deleting, requestDelete] = useHappyAction(async () => {
        try {
            await machineDeleteEventSubscription(machineId, subscription.id);
        } catch {
            Modal.alert(t('common.error'), t('event.deleteError'), [{ text: t('common.ok') }]);
        }
    });

    const confirmDelete = React.useCallback(() => {
        Modal.alert(t('event.delete'), t('event.deleteConfirm'), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('event.delete'), style: 'destructive', onPress: requestDelete },
        ]);
    }, [requestDelete]);

    return (
        <Item
            title={subscription.eventType}
            subtitle={`${subscription.directory} · ${subscription.enabled ? t('event.statusEnabled') : t('event.statusDisabled')}`}
            detail={`${tierLabel(subscription.tier)} · ${subscription.preset}`}
            icon={<Ionicons name="git-commit-outline" size={29} color={theme.colors.textSecondary} />}
            showChevron={false}
            loading={deleting}
            rightElement={
                <Pressable
                    onPress={confirmDelete}
                    disabled={deleting}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('event.delete')}
                    style={{ padding: 6 }}
                >
                    <Ionicons name="trash-outline" size={22} color={theme.colors.textDestructive} />
                </Pressable>
            }
        />
    );
}

function EventSubscriptionsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();

    // Default to the first online machine, mirroring crons/index.tsx. useAllMachines()
    // without options returns only active (online) machines, newest first.
    const machines = useAllMachines();
    const machineId = machines.length > 0 ? machines[0].id : null;

    const { subscriptions, loading } = useEventSubscriptionsPolling(machineId);

    return (
        <ItemList>
            <ItemGroup>
                <Item
                    title={t('event.submit')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.primary.background} />}
                    onPress={() => router.push('/event-subscriptions/new' as any)}
                    disabled={!machineId}
                />
            </ItemGroup>

            {!machineId && (
                <ItemGroup>
                    <Item
                        title={t('newSession.machineOffline')}
                        subtitle={t('machine.offlineHelp')}
                        icon={<Ionicons name="cloud-offline-outline" size={29} color={theme.colors.status.disconnected} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {machineId && loading && subscriptions.length === 0 && (
                <ItemGroup>
                    <Item
                        title={t('common.loading')}
                        loading
                        showChevron={false}
                        titleStyle={{ color: theme.colors.textSecondary }}
                    />
                </ItemGroup>
            )}

            {machineId && !loading && subscriptions.length === 0 && (
                <ItemGroup>
                    <Item
                        title={t('event.empty')}
                        showChevron={false}
                        titleStyle={{ color: theme.colors.textSecondary }}
                    />
                </ItemGroup>
            )}

            {machineId && subscriptions.length > 0 && (
                <ItemGroup>
                    {subscriptions.map((subscription) => (
                        <EventSubscriptionRow key={subscription.id} machineId={machineId} subscription={subscription} />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
}

export default React.memo(EventSubscriptionsScreen);
