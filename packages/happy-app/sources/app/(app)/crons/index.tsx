import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines } from '@/sync/storage';
import { useCronsPolling } from '@/hooks/useCronsPolling';
import { machineDeleteCron, type CronScheduleView } from '@/sync/cronOps';
import { useHappyAction } from '@/hooks/useHappyAction';
import { Modal } from '@/modal';
import { t } from '@/text';

// Map a cron-schedule tier to its localized label.
function tierLabel(tier: CronScheduleView['tier']): string {
    return tier === 'trusted' ? t('cron.tierTrusted') : t('cron.tierSupervised');
}

function CronRow({ machineId, schedule }: { machineId: string; schedule: CronScheduleView }) {
    const { theme } = useUnistyles();

    // useHappyAction provides the double-tap guard (UX-9, in-flight ref) and
    // surfaces a failed delete via Modal.alert (UX-1) instead of swallowing it.
    const [deleting, requestDelete] = useHappyAction(async () => {
        try {
            await machineDeleteCron(machineId, schedule.id);
        } catch {
            Modal.alert(t('common.error'), t('cron.deleteError'), [{ text: t('common.ok') }]);
        }
    });

    const confirmDelete = React.useCallback(() => {
        Modal.alert(t('cron.delete'), t('cron.deleteConfirm'), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('cron.delete'), style: 'destructive', onPress: requestDelete },
        ]);
    }, [requestDelete]);

    return (
        <Item
            title={schedule.cronExpr}
            subtitle={`${schedule.directory} · ${schedule.enabled ? t('cron.statusEnabled') : t('cron.statusDisabled')}`}
            detail={`${tierLabel(schedule.tier)} · ${schedule.preset}`}
            icon={<Ionicons name="time-outline" size={29} color={theme.colors.textSecondary} />}
            showChevron={false}
            loading={deleting}
            rightElement={
                <Pressable
                    onPress={confirmDelete}
                    disabled={deleting}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('cron.delete')}
                    style={{ padding: 6 }}
                >
                    <Ionicons name="trash-outline" size={22} color={theme.colors.textDestructive} />
                </Pressable>
            }
        />
    );
}

function CronsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();

    // Default to the first online machine, mirroring runs/index.tsx. useAllMachines()
    // without options returns only active (online) machines, newest first.
    const machines = useAllMachines();
    const machineId = machines.length > 0 ? machines[0].id : null;

    const { crons, loading } = useCronsPolling(machineId);

    return (
        <ItemList>
            <ItemGroup>
                <Item
                    title={t('cron.submit')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.primary.background} />}
                    onPress={() => router.push('/crons/new' as any)}
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

            {machineId && loading && crons.length === 0 && (
                <ItemGroup>
                    <Item
                        title={t('common.loading')}
                        loading
                        showChevron={false}
                        titleStyle={{ color: theme.colors.textSecondary }}
                    />
                </ItemGroup>
            )}

            {machineId && !loading && crons.length === 0 && (
                <ItemGroup>
                    <Item
                        title={t('cron.empty')}
                        showChevron={false}
                        titleStyle={{ color: theme.colors.textSecondary }}
                    />
                </ItemGroup>
            )}

            {machineId && crons.length > 0 && (
                <ItemGroup>
                    {crons.map((schedule) => (
                        <CronRow key={schedule.id} machineId={machineId} schedule={schedule} />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
}

export default React.memo(CronsScreen);
