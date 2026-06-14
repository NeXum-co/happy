import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines } from '@/sync/storage';
import { useJobsPolling } from '@/hooks/useJobsPolling';
import type { JobRecordView } from '@/sync/runOps';
import { t } from '@/text';

// Map a job status to its localized label.
function statusLabel(status: JobRecordView['status']): string {
    switch (status) {
        case 'pending': return t('run.statusPending');
        case 'running': return t('run.statusRunning');
        case 'succeeded': return t('run.statusSucceeded');
        case 'failed': return t('run.statusFailed');
        case 'dead': return t('run.statusDead');
        case 'needs-attention': return t('run.statusNeedsAttention');
    }
}

// Map a job tier to its localized label.
function tierLabel(tier: JobRecordView['tier']): string {
    return tier === 'trusted' ? t('run.tierTrusted') : t('run.tierSupervised');
}

// Truncate the prompt for the list title.
function truncatePrompt(prompt: string): string {
    const trimmed = prompt.trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

// Ordering: needs-attention + running first, then pending, then finished states.
const STATUS_ORDER: Record<JobRecordView['status'], number> = {
    'needs-attention': 0,
    running: 1,
    pending: 2,
    succeeded: 3,
    failed: 4,
    dead: 5,
};

function RunsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();

    // Default to the first online machine, mirroring new/index.tsx. useAllMachines()
    // without options returns only active (online) machines, newest first.
    const machines = useAllMachines();
    const machineId = machines.length > 0 ? machines[0].id : null;

    const { jobs } = useJobsPolling(machineId);

    const sortedJobs = React.useMemo(() => {
        return [...jobs].sort((a, b) => {
            const orderDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
            if (orderDiff !== 0) return orderDiff;
            return b.createdAt - a.createdAt;
        });
    }, [jobs]);

    return (
        <ItemList>
            <ItemGroup>
                <Item
                    title={t('run.submit')}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.button.primary.background} />}
                    onPress={() => router.push('/runs/new' as any)}
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

            {machineId && sortedJobs.length === 0 && (
                <ItemGroup>
                    <Item
                        title={t('run.empty')}
                        showChevron={false}
                        titleStyle={{ color: theme.colors.textSecondary }}
                    />
                </ItemGroup>
            )}

            {machineId && sortedJobs.length > 0 && (
                <ItemGroup>
                    {sortedJobs.map((job) => (
                        <Item
                            key={job.id}
                            title={truncatePrompt(job.prompt)}
                            subtitle={`${statusLabel(job.status)} · ${tierLabel(job.tier)}`}
                            detail={t('run.costLine', { usd: (job.costUsd ?? 0).toFixed(2) })}
                            icon={<Ionicons name="hardware-chip-outline" size={29} color={theme.colors.textSecondary} />}
                            onPress={() => router.push(`/runs/${job.id}` as any)}
                        />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
}

export default React.memo(RunsScreen);
