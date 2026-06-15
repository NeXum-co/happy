import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines } from '@/sync/storage';
import { useEventSubscriptionsPolling } from '@/hooks/useEventSubscriptionsPolling';
import { machineDeleteEventSubscription, type EventSubscriptionView } from '@/sync/eventOps';
import { Modal } from '@/modal';
import { t } from '@/text';

// Map an event-subscription tier to its localized label.
function tierLabel(tier: EventSubscriptionView['tier']): string {
    return tier === 'trusted' ? t('event.tierTrusted') : t('event.tierSupervised');
}

function EventSubscriptionsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();

    // Default to the first online machine, mirroring crons/index.tsx. useAllMachines()
    // without options returns only active (online) machines, newest first.
    const machines = useAllMachines();
    const machineId = machines.length > 0 ? machines[0].id : null;

    const { subscriptions } = useEventSubscriptionsPolling(machineId);

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

            {machineId && subscriptions.length === 0 && (
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
                        <Item
                            key={subscription.id}
                            title={subscription.eventType}
                            subtitle={`${subscription.directory} · ${subscription.enabled ? t('event.statusEnabled') : t('event.statusDisabled')}`}
                            detail={`${tierLabel(subscription.tier)} · ${subscription.preset}`}
                            icon={<Ionicons name="git-commit-outline" size={29} color={theme.colors.textSecondary} />}
                            onPress={() => Modal.alert(t('event.delete'), t('event.deleteConfirm'), [
                                { text: t('common.cancel'), style: 'cancel' },
                                {
                                    text: t('event.delete'),
                                    style: 'destructive',
                                    onPress: async () => {
                                        await machineDeleteEventSubscription(machineId, subscription.id);
                                    },
                                },
                            ])}
                        />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
}

export default React.memo(EventSubscriptionsScreen);
