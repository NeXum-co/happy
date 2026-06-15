import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines } from '@/sync/storage';
import { useCronsPolling } from '@/hooks/useCronsPolling';
import { machineDeleteCron, type CronScheduleView } from '@/sync/cronOps';
import { Modal } from '@/modal';
import { t } from '@/text';

// Map a cron-schedule tier to its localized label.
function tierLabel(tier: CronScheduleView['tier']): string {
    return tier === 'trusted' ? t('cron.tierTrusted') : t('cron.tierSupervised');
}

function CronsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();

    // Default to the first online machine, mirroring runs/index.tsx. useAllMachines()
    // without options returns only active (online) machines, newest first.
    const machines = useAllMachines();
    const machineId = machines.length > 0 ? machines[0].id : null;

    const { crons } = useCronsPolling(machineId);

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

            {machineId && crons.length === 0 && (
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
                        <Item
                            key={schedule.id}
                            title={schedule.cronExpr}
                            subtitle={`${schedule.directory} · ${schedule.enabled ? t('cron.statusEnabled') : t('cron.statusDisabled')}`}
                            detail={`${tierLabel(schedule.tier)} · ${schedule.preset}`}
                            icon={<Ionicons name="time-outline" size={29} color={theme.colors.textSecondary} />}
                            onPress={() => Modal.alert(t('cron.delete'), t('cron.deleteConfirm'), [
                                { text: t('common.cancel'), style: 'cancel' },
                                {
                                    text: t('cron.delete'),
                                    style: 'destructive',
                                    onPress: async () => {
                                        await machineDeleteCron(machineId, schedule.id);
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

export default React.memo(CronsScreen);
