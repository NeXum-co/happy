import * as React from 'react';
import { View } from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useHappyAction } from '@/hooks/useHappyAction';
import { machineGetJob, machineStopJob, type JobRecordView } from '@/sync/runOps';
import { Modal } from '@/modal';
import { t } from '@/text';

// Localized status / tier labels (kept inline — three trivial mappings, not
// worth a shared module across two screens).
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

function tierLabel(tier: JobRecordView['tier']): string {
    return tier === 'trusted' ? t('run.tierTrusted') : t('run.tierSupervised');
}

// Wall-clock duration of the run, in whole seconds, as a short string.
function durationLabel(job: JobRecordView): string {
    if (!job.claimedAt) {
        return '—';
    }
    const end = job.finishedAt ?? Date.now();
    const seconds = Math.max(0, Math.round((end - job.claimedAt) / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
}

const POLL_INTERVAL_MS = 2000;

function JobDetailScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { jobId } = useLocalSearchParams<{ jobId: string }>();
    const machines = useAllMachines({ includeOffline: true });
    const machineId = React.useMemo(
        () => machines.find(isMachineOnline)?.id ?? machines[0]?.id ?? null,
        [machines],
    );

    const [job, setJob] = React.useState<JobRecordView | null>(null);

    useFocusEffect(
        React.useCallback(() => {
            if (!machineId || !jobId) {
                return;
            }
            let cancelled = false;
            const tick = async () => {
                const next = await machineGetJob(machineId, jobId);
                if (!cancelled) {
                    setJob(next);
                }
            };
            tick();
            const interval = setInterval(tick, POLL_INTERVAL_MS);
            return () => {
                cancelled = true;
                clearInterval(interval);
            };
        }, [machineId, jobId]),
    );

    const [, stop] = useHappyAction(async () => {
        if (!machineId || !job?.sessionId) {
            return;
        }
        const approved = await Modal.confirm(t('run.stop'), t('run.stopConfirm'), {
            cancelText: t('common.cancel'),
            confirmText: t('run.stop'),
        });
        if (approved) {
            await machineStopJob(machineId, job.sessionId);
        }
    });

    if (!job) {
        return <View style={{ flex: 1 }} />;
    }

    return (
        <ItemList>
            <ItemGroup>
                <Item title={t('run.fieldPrompt')} subtitle={job.prompt} subtitleLines={0} showChevron={false} />
            </ItemGroup>

            <ItemGroup>
                <Item title={t('run.fieldTier')} detail={tierLabel(job.tier)} showChevron={false} />
                <Item title={t('run.fieldPreset')} detail={job.preset} showChevron={false} />
                <Item title="Trigger" detail={job.triggerType} showChevron={false} />
                <Item
                    title={statusLabel(job.status)}
                    detail={durationLabel(job)}
                    showChevron={false}
                />
                <Item
                    title={t('run.costLine', { usd: (job.costUsd ?? 0).toFixed(2) })}
                    detail={job.maxBudgetUsd !== undefined ? t('run.budgetLine', { usd: job.maxBudgetUsd.toFixed(2) }) : undefined}
                    showChevron={false}
                />
                <Item
                    title={t('run.attempts', { n: job.attempts, max: job.maxAttempts })}
                    detail={job.exitReason ? t('run.exitReason', { reason: job.exitReason }) : undefined}
                    showChevron={false}
                />
            </ItemGroup>

            {(job.sessionId || job.status === 'running') && (
                <ItemGroup>
                    {job.sessionId && (
                        <Item
                            title={t('run.openSession')}
                            icon={<Ionicons name="open-outline" size={29} color={theme.colors.button.primary.background} />}
                            onPress={() => router.push(`/session/${job.sessionId}` as any)}
                        />
                    )}
                    {job.status === 'running' && job.sessionId && (
                        <Item
                            title={t('run.stop')}
                            destructive
                            icon={<Ionicons name="stop-circle-outline" size={29} color={theme.colors.textDestructive} />}
                            onPress={stop}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>
            )}
        </ItemList>
    );
}

export default React.memo(JobDetailScreen);
