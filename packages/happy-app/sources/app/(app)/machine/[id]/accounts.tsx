import React, { memo, useState, useCallback, useMemo } from 'react';
import { View, ActivityIndicator, RefreshControl, Pressable } from 'react-native';
import Slider from '@react-native-community/slider';
import { Text } from '@/components/StyledText';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
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
    machineGetBurnPolicy,
    machineSetBurnPolicy,
    type AccountInfo,
    type AccountUsage,
    type BurnPolicyConfig,
} from '@/sync/ops';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

const DEFAULT_BURN_POLICY: BurnPolicyConfig = { enabled: false, order: [], thresholdPct: 0.9 };

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
    const [policy, setPolicy] = useState<BurnPolicyConfig>(DEFAULT_BURN_POLICY);
    const [loaded, setLoaded] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const load = useCallback(async () => {
        if (!machineId) return;
        const [accs, use, pol] = await Promise.all([
            machineListAccounts(machineId),
            machineGetUsage(machineId).catch(() => ({})), // usage is fail-soft (D-E10-6)
            machineGetBurnPolicy(machineId).catch(() => DEFAULT_BURN_POLICY),
        ]);
        setAccounts(accs);
        setUsage(use);
        setPolicy(pol);
        setLoaded(true);
    }, [machineId]);

    // Persist the burn-policy optimistically; on RPC failure revert by reloading (S6).
    const persistPolicy = useCallback(async (next: BurnPolicyConfig) => {
        setPolicy(next);
        try {
            await machineSetBurnPolicy(machineId!, next);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : 'Unknown error');
            await load();
        }
    }, [machineId, load]);

    // Burn order = configured order (filtered to existing accounts) + any remaining accounts appended.
    const orderedNames = useMemo(() => {
        const inOrder = policy.order.filter(n => accounts.some(a => a.name === n));
        const rest = accounts.map(a => a.name).filter(n => !inOrder.includes(n));
        return [...inOrder, ...rest];
    }, [policy.order, accounts]);

    const moveAccount = useCallback((index: number, dir: -1 | 1) => {
        const next = [...orderedNames];
        const j = index + dir;
        if (j < 0 || j >= next.length) return;
        [next[index], next[j]] = [next[j], next[index]];
        persistPolicy({ ...policy, order: next });
    }, [orderedNames, policy, persistPolicy]);

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

                {loaded && accounts.length > 0 && (
                    <ItemGroup title={t('subscriptions.burnPolicy.title')} footer={t('subscriptions.burnPolicy.hint')}>
                        <Item
                            title={t('subscriptions.burnPolicy.enable')}
                            icon={<Ionicons name="flame-outline" size={29} color={theme.colors.textSecondary} />}
                            rightElement={
                                <Switch
                                    value={policy.enabled}
                                    onValueChange={(v) => persistPolicy({ ...policy, enabled: v, order: orderedNames })}
                                />
                            }
                            showChevron={false}
                            showDivider={policy.enabled}
                        />
                        {policy.enabled && (
                            <>
                                <View style={styles.sliderRow}>
                                    <Text style={[styles.sliderLabel, { color: theme.colors.text }]}>
                                        {t('subscriptions.burnPolicy.threshold', { pct: Math.round(policy.thresholdPct * 100) })}
                                    </Text>
                                    <Slider
                                        minimumValue={0}
                                        maximumValue={1}
                                        step={0.05}
                                        value={policy.thresholdPct}
                                        onValueChange={(v) => setPolicy(p => ({ ...p, thresholdPct: v }))}
                                        onSlidingComplete={(v) => persistPolicy({ ...policy, thresholdPct: v, order: orderedNames })}
                                        minimumTrackTintColor={theme.colors.text}
                                        maximumTrackTintColor={theme.colors.divider}
                                    />
                                </View>
                                <Text style={[styles.orderHeading, { color: theme.colors.textSecondary }]}>
                                    {t('subscriptions.burnPolicy.order')}
                                </Text>
                                {orderedNames.map((name, index) => (
                                    <Item
                                        key={name}
                                        title={`${index + 1}. ${name}`}
                                        showChevron={false}
                                        showDivider={index < orderedNames.length - 1}
                                        rightElement={
                                            <View style={styles.reorderButtons}>
                                                <Pressable
                                                    accessibilityLabel={t('subscriptions.burnPolicy.moveUp')}
                                                    disabled={index === 0}
                                                    onPress={() => moveAccount(index, -1)}
                                                    style={styles.reorderButton}
                                                >
                                                    <Ionicons name="chevron-up" size={22} color={index === 0 ? theme.colors.divider : theme.colors.text} />
                                                </Pressable>
                                                <Pressable
                                                    accessibilityLabel={t('subscriptions.burnPolicy.moveDown')}
                                                    disabled={index === orderedNames.length - 1}
                                                    onPress={() => moveAccount(index, 1)}
                                                    style={styles.reorderButton}
                                                >
                                                    <Ionicons name="chevron-down" size={22} color={index === orderedNames.length - 1 ? theme.colors.divider : theme.colors.text} />
                                                </Pressable>
                                            </View>
                                        }
                                    />
                                ))}
                            </>
                        )}
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
    sliderRow: {
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    sliderLabel: {
        fontSize: 15,
        marginBottom: 4,
    },
    orderHeading: {
        fontSize: 13,
        textTransform: 'uppercase',
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 4,
    },
    reorderButtons: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    reorderButton: {
        paddingHorizontal: 6,
        paddingVertical: 4,
    },
}));
