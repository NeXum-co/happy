import React, { memo, useState, useCallback, useMemo } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from '@/modal';
import { useHappyAction } from '@/hooks/useHappyAction';
import {
    machineListSessions,
    machineListAccounts,
    machineAccountSwitch,
    type SessionAccountInfo,
    type AccountInfo,
} from '@/sync/ops';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

// E10 S5.4 — multi-select migration popup (AC-4). Lists running sessions grouped
// by their live account (from the daemon's `list` RPC — the fresh source), lets
// the user pick a subset and a target account, then live-remaps them via
// account-switch (no respawn). Fail-closed target → ok:false; unbound/terminal
// sessions land in `skipped`.
export default memo(function AccountMigrateScreen() {
    const { theme } = useUnistyles();
    const { id: machineId } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const [sessions, setSessions] = useState<SessionAccountInfo[]>([]);
    const [accounts, setAccounts] = useState<AccountInfo[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [target, setTarget] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!machineId) return;
        const [sess, accs] = await Promise.all([
            machineListSessions(machineId),
            machineListAccounts(machineId),
        ]);
        setSessions(sess);
        setAccounts(accs);
        setLoaded(true);
    }, [machineId]);

    useFocusEffect(useCallback(() => { load().catch(() => setLoaded(true)); }, [load]));

    // Group sessions by their current account; unbound sessions under a null key.
    const groups = useMemo(() => {
        const map = new Map<string | null, SessionAccountInfo[]>();
        for (const s of sessions) {
            const key = s.account ?? null;
            const arr = map.get(key) ?? [];
            arr.push(s);
            map.set(key, arr);
        }
        return Array.from(map.entries());
    }, [sessions]);

    const toggle = useCallback((id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const [switching, doSwitch] = useHappyAction(useCallback(async () => {
        if (selected.size === 0 || !target) return;
        const result = await machineAccountSwitch(machineId!, Array.from(selected), target);
        if (!result.ok) {
            Modal.alert(t('common.error'), result.error || t('subscriptions.migrateFailed'));
            return;
        }
        const remapped = result.remapped?.length ?? 0;
        const skipped = result.skipped?.length ?? 0;
        Modal.alert(t('subscriptions.migrateDoneTitle'), t('subscriptions.migrateResult', { remapped, skipped }));
        setSelected(new Set());
        await load();
    }, [machineId, selected, target, load]));

    const canSubmit = selected.size > 0 && !!target && !switching;

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('subscriptions.migrateTitle'), headerBackTitle: t('machine.back') }} />
            <ItemList>
                {!loaded && (
                    <View style={styles.centered}><ActivityIndicator color={theme.colors.textSecondary} /></View>
                )}

                {loaded && sessions.length === 0 && (
                    <ItemGroup footer={t('subscriptions.migrateInstructions')}>
                        <Item title={t('subscriptions.migrateNoSessions')} showChevron={false} />
                    </ItemGroup>
                )}

                {loaded && sessions.length > 0 && (
                    <>
                        {groups.map(([account, sess]) => (
                            <ItemGroup key={account ?? '__unbound__'} title={account ?? t('subscriptions.migrateUnbound')}>
                                {sess.map((s) => {
                                    const isSel = selected.has(s.happySessionId);
                                    return (
                                        <Item
                                            key={s.happySessionId}
                                            title={s.happySessionId}
                                            titleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                            subtitle={t('subscriptions.sessionPid', { pid: s.pid })}
                                            onPress={() => toggle(s.happySessionId)}
                                            showChevron={false}
                                            rightElement={
                                                <Ionicons
                                                    name={isSel ? 'checkbox' : 'square-outline'}
                                                    size={24}
                                                    color={isSel ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                                />
                                            }
                                        />
                                    );
                                })}
                            </ItemGroup>
                        ))}

                        <ItemGroup title={t('subscriptions.migrateSelectTarget')}>
                            {accounts.map((a) => (
                                <Item
                                    key={a.name}
                                    title={a.name}
                                    detail={a.isDefault ? t('subscriptions.defaultBadge') : undefined}
                                    onPress={() => setTarget(a.name)}
                                    showChevron={false}
                                    rightElement={
                                        <Ionicons
                                            name={target === a.name ? 'checkmark-circle' : 'ellipse-outline'}
                                            size={24}
                                            color={target === a.name ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                        />
                                    }
                                />
                            ))}
                        </ItemGroup>

                        <View style={styles.submit}>
                            <RoundButton
                                title={t('subscriptions.migrateButton', { count: selected.size })}
                                loading={switching}
                                disabled={!canSubmit}
                                onPress={doSwitch}
                            />
                        </View>
                    </>
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
    submit: {
        paddingHorizontal: 16,
        marginTop: 16,
        marginBottom: 32,
    },
}));
