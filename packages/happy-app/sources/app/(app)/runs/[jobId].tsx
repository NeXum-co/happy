import * as React from 'react';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useHappyAction } from '@/hooks/useHappyAction';
import { machineGetJob, machineStopJob, machineCancelJob, machineResolveGate, type JobRecordView } from '@/sync/runOps';
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

    const [, cancel] = useHappyAction(async () => {
        if (!machineId || !job?.id) {
            return;
        }
        const approved = await Modal.confirm(t('run.cancel'), t('run.cancelConfirm'), {
            cancelText: t('common.cancel'),
            confirmText: t('run.cancel'),
        });
        if (approved) {
            await machineCancelJob(machineId, job.id);
        }
    });

    // E05 gate-parked jobs (exitReason 'gate:*'): approve runs the job at its gated
    // tier, reject drives it to dead. The poll loop refreshes the status.
    const [, approveGate] = useHappyAction(async () => {
        if (!machineId || !job?.id) {
            return;
        }
        const confirmed = await Modal.confirm(t('run.approve'), t('run.approveConfirm'), {
            cancelText: t('common.cancel'),
            confirmText: t('run.approve'),
        });
        if (confirmed) {
            await machineResolveGate(machineId, job.id, 'approve');
        }
    });

    const [, rejectGate] = useHappyAction(async () => {
        if (!machineId || !job?.id) {
            return;
        }
        const confirmed = await Modal.confirm(t('run.reject'), t('run.rejectConfirm'), {
            cancelText: t('common.cancel'),
            confirmText: t('run.reject'),
        });
        if (confirmed) {
            await machineResolveGate(machineId, job.id, 'reject');
        }
    });

    if (!job) {
        return (
            <ItemList>
                <ItemGroup>
                    <Item
                        title={t('common.loading')}
                        showChevron={false}
                        titleStyle={{ color: theme.colors.textSecondary }}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList>
            {job.status === 'needs-attention' && (
                <ItemGroup>
                    <Item
                        title={t('run.escalation')}
                        icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.textDestructive} />}
                        titleStyle={{ color: theme.colors.textDestructive }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            <ItemGroup>
                <Item title={t('run.fieldPrompt')} subtitle={job.prompt} subtitleLines={0} showChevron={false} />
            </ItemGroup>

            <ItemGroup>
                <Item title={t('run.fieldTier')} detail={tierLabel(job.tier)} showChevron={false} />
                <Item title={t('run.fieldPreset')} detail={job.preset} showChevron={false} />
                <Item title={t('run.fieldTrigger')} detail={job.triggerType} showChevron={false} />
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

            {(job.dispositionTopic || job.gateReason) && (
                <ItemGroup>
                    {job.dispositionTopic && (
                        <Item title={t('run.fieldDispositionTopic')} detail={job.dispositionTopic} showChevron={false} />
                    )}
                    {job.gateAction && (
                        <Item title={t('run.fieldGateAction')} detail={job.gateAction} showChevron={false} />
                    )}
                    {job.gateBucket && (
                        <Item title={t('run.fieldGateBucket')} detail={job.gateBucket} showChevron={false} />
                    )}
                    {job.gateReason && (
                        <Item title={t('run.fieldGateReason')} detail={job.gateReason} showChevron={false} />
                    )}
                </ItemGroup>
            )}

            {job.status === 'needs-attention' && (job.exitReason?.startsWith('gate:') ?? false) && (
                <ItemGroup>
                    <Item
                        title={t('run.approve')}
                        icon={<Ionicons name="checkmark-circle-outline" size={29} color={theme.colors.button.primary.background} />}
                        onPress={approveGate}
                        showChevron={false}
                    />
                    <Item
                        title={t('run.reject')}
                        destructive
                        icon={<Ionicons name="close-circle-outline" size={29} color={theme.colors.textDestructive} />}
                        onPress={rejectGate}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {job.sessionId && (
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

            {job.status === 'pending' && (
                <ItemGroup>
                    <Item
                        title={t('run.cancel')}
                        destructive
                        icon={<Ionicons name="close-circle-outline" size={29} color={theme.colors.textDestructive} />}
                        onPress={cancel}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
}

export default React.memo(JobDetailScreen);
