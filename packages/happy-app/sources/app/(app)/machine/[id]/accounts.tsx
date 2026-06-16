import React, { memo, useState, useCallback } from 'react';
import { View, ActivityIndicator, RefreshControl } from 'react-native';
import { Text } from '@/components/StyledText';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { UsageBar } from '@/components/usage/UsageBar';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { useMachine } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import {
    machineListAccounts,
    machineGetUsage,
    machineSetDefaultAccount,
    machineRemoveAccount,
    type AccountInfo,
    type AccountUsage,
} from '@/sync/ops';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

// E10 multi-subscription — per-machine accounts screen (D-E10-17). Lists the
// vault accounts on this machine's daemon, shows per-account 5h/7d usage
// (fail-soft → "unknown", never a fake number), and offers set-default / remove
// plus an add-via-paste-token entry. Accounts are per-daemon, so this lives
// under machine/[id].
export default memo(function MachineAccountsScreen() {
    const { theme } = useUnistyles();
    const { id: machineId } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const machine = useMachine(machineId!);
    const [accounts, setAccounts] = useState<AccountInfo[]>([]);
    const [usage, setUsage] = useState<Record<string, AccountUsage>>({});
    const [loaded, setLoaded] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const load = useCallback(async () => {
        if (!machineId) return;
        const [accs, use] = await Promise.all([
            machineListAccounts(machineId),
            machineGetUsage(machineId).catch(() => ({})), // usage is fail-soft (D-E10-6)
        ]);
        setAccounts(accs);
        setUsage(use);
        setLoaded(true);
    }, [machineId]);

    // Refetch on focus so a freshly-added account (from the add screen) shows up.
    useFocusEffect(useCallback(() => { load().catch(() => setLoaded(true)); }, [load]));

    const handleRefresh = useCallback(async () => {
        setIsRefreshing(true);
        try { await load(); } finally { setIsRefreshing(false); }
    }, [load]);

    const openActions = useCallback((account: AccountInfo) => {
        const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
        if (!account.isDefault) {
            buttons.push({
                text: t('subscriptions.setDefault'),
                onPress: async () => {
                    try {
                        await machineSetDefaultAccount(machineId!, account.name);
                        await load();
                    } catch (e) {
                        Modal.alert(t('common.error'), e instanceof Error ? e.message : 'Unknown error');
                    }
                },
            });
        }
        buttons.push({
            text: t('subscriptions.remove'),
            style: 'destructive',
            onPress: async () => {
                const confirmed = await Modal.confirm(
                    t('subscriptions.removeConfirmTitle'),
                    t('subscriptions.removeConfirmMessage', { name: account.name }),
                    { cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true },
                );
                if (!confirmed) return;
                try {
                    await machineRemoveAccount(machineId!, account.name);
                    await load();
                } catch (e) {
                    Modal.alert(t('common.error'), e instanceof Error ? e.message : 'Unknown error');
                }
            },
        });
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert(t('subscriptions.accountActionsTitle', { name: account.name }), undefined, buttons);
    }, [machineId, load]);

    const online = !!machine && isMachineOnline(machine);

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('subscriptions.title'), headerBackTitle: t('machine.back') }} />
            <ItemList
                refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
            >
                {!online && (
                    <ItemGroup>
                        <Item title={t('machine.offlineUnableToSpawn')} subtitle={t('machine.offlineHelp')} subtitleLines={0} showChevron={false} />
                    </ItemGroup>
                )}

                {!loaded && online && (
                    <View style={styles.centered}>
                        <ActivityIndicator color={theme.colors.textSecondary} />
                    </View>
                )}

                {loaded && (
                    <ItemGroup title={t('subscriptions.sectionAccounts')} footer={t('subscriptions.accountsFooter')}>
                        {accounts.length === 0 && (
                            <Item
                                title={t('subscriptions.noAccounts')}
                                subtitle={t('subscriptions.noAccountsSubtitle')}
                                subtitleLines={0}
                                showChevron={false}
                            />
                        )}
                        {accounts.map((account) => {
                            const u = usage[account.name];
                            const hasUsage = !!u && (u.fiveHourUtil !== null || u.sevenDayUtil !== null);
                            return (
                                <View key={account.name}>
                                    <Item
                                        title={account.name}
                                        detail={account.isDefault ? t('subscriptions.defaultBadge') : undefined}
                                        detailStyle={account.isDefault ? { color: '#34C759' } : undefined}
                                        icon={<Ionicons name="person-circle-outline" size={29} color={theme.colors.textSecondary} />}
                                        onPress={() => openActions(account)}
                                        showChevron
                                        showDivider={false}
                                    />
                                    <View style={styles.usageWrap}>
                                        {hasUsage ? (
                                            <>
                                                <UsageBar label={t('subscriptions.usage5h')} value={u!.fiveHourUtil ?? 0} maxValue={1} showPercentage />
                                                <UsageBar label={t('subscriptions.usage7d')} value={u!.sevenDayUtil ?? 0} maxValue={1} showPercentage />
                                            </>
                                        ) : (
                                            <Text style={[styles.usageUnknown, { color: theme.colors.textSecondary }]}>
                                                {t('subscriptions.usageUnknown')}
                                            </Text>
                                        )}
                                    </View>
                                </View>
                            );
                        })}
                        <Item
                            title={t('subscriptions.addAccount')}
                            icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.text} />}
                            onPress={() => router.push(`/machine/${machineId}/account-add`)}
                            showDivider={false}
                        />
                    </ItemGroup>
                )}

                {loaded && (
                    <ItemGroup>
                        <Item
                            title={t('subscriptions.migrateRow')}
                            icon={<Ionicons name="swap-horizontal-outline" size={29} color={theme.colors.text} />}
                            onPress={() => router.push(`/machine/${machineId}/account-migrate`)}
                        />
                    </ItemGroup>
                )}
            </ItemList>
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    centered: {
        paddingVertical: 32,
        alignItems: 'center',
    },
    usageWrap: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        paddingTop: 4,
    },
    usageUnknown: {
        fontSize: 13,
        fontStyle: 'italic',
    },
}));
