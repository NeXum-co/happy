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

// Localized gate-verdict labels — the raw enum values (e.g. 'override-prone',
// 'proceed-supervised') are internal and unreadable to a reviewer (UX-002).
function gateActionLabel(action: NonNullable<JobRecordView['gateAction']>): string {
    switch (action) {
        case 'proceed': return t('run.gateActionProceed');
        case 'proceed-supervised': return t('run.gateActionProceedSupervised');
        case 'escalate': return t('run.gateActionEscalate');
        case 'hold': return t('run.gateActionHold');
    }
}

function gateBucketLabel(bucket: NonNullable<JobRecordView['gateBucket']>): string {
    switch (bucket) {
        case 'high-trust': return t('run.gateBucketHighTrust');
        case 'modify-prone': return t('run.gateBucketModifyProne');
        case 'mixed': return t('run.gateBucketMixed');
        case 'override-prone': return t('run.gateBucketOverrideProne');
        case 'thin': return t('run.gateBucketThin');
    }
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
            let interval: ReturnType<typeof setInterval> | undefined;
            const isTerminal = (s: JobRecordView['status']) => s === 'succeeded' || s === 'dead' || s === 'failed';
            const tick = async () => {
                const next = await machineGetJob(machineId, jobId);
                if (cancelled) {
                    return;
                }
                setJob(next);
                // PERF-002: stop polling once the job is terminal — its record is
                // immutable from here, so further get-job round-trips are wasted.
                if (next && isTerminal(next.status) && interval) {
                    clearInterval(interval);
                    interval = undefined;
                }
            };
            tick();
            interval = setInterval(tick, POLL_INTERVAL_MS);
            return () => {
                cancelled = true;
                if (interval) {
                    clearInterval(interval);
                }
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
    const [approving, approveGate] = useHappyAction(async () => {
        if (!machineId || !job?.id) {
            return;
        }
        const confirmed = await Modal.confirm(t('run.approve'), t('run.approveConfirm'), {
            cancelText: t('common.cancel'),
            confirmText: t('run.approve'),
        });
        if (confirmed) {
            // SF-004: resolveGate returns { resolved: false } when the job is no longer
            // parked (already resolved / changed). Surface it instead of silently no-op'ing.
            const { resolved } = await machineResolveGate(machineId, job.id, 'approve');
            if (!resolved) {
                Modal.alert(t('run.resolveGateFailed'), t('run.resolveGateFailedMessage'), [{ text: t('common.ok') }]);
            }
        }
    });

    const [rejecting, rejectGate] = useHappyAction(async () => {
        if (!machineId || !job?.id) {
            return;
        }
        const confirmed = await Modal.confirm(t('run.reject'), t('run.rejectConfirm'), {
            cancelText: t('common.cancel'),
            confirmText: t('run.reject'),
            destructive: true,
        });
        if (confirmed) {
            const { resolved } = await machineResolveGate(machineId, job.id, 'reject');
            if (!resolved) {
                Modal.alert(t('run.resolveGateFailed'), t('run.resolveGateFailedMessage'), [{ text: t('common.ok') }]);
            }
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

            {(job.dispositionTopic || job.untrustedInput || (!job.gateResolved && job.gateReason)) && (
                <ItemGroup>
                    {job.dispositionTopic && (
                        <Item title={t('run.fieldDispositionTopic')} detail={job.dispositionTopic} showChevron={false} />
                    )}
                    {job.untrustedInput && (
                        <Item title={t('run.fieldUntrustedInput')} detail={t('common.yes')} showChevron={false} />
                    )}
                    {/* UX-006: once Joshua approved the parked job (gateResolved), the held
                        verdict is history — show only the topic, not the "why held" rows. */}
                    {!job.gateResolved && job.gateAction && (
                        <Item title={t('run.fieldGateAction')} detail={gateActionLabel(job.gateAction)} showChevron={false} />
                    )}
                    {!job.gateResolved && job.gateBucket && (
                        <Item title={t('run.fieldGateBucket')} detail={gateBucketLabel(job.gateBucket)} showChevron={false} />
                    )}
                    {!job.gateResolved && job.gateReason && (
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
                        loading={approving}
                        disabled={approving || rejecting}
                        showChevron={false}
                    />
                    <Item
                        title={t('run.reject')}
                        destructive
                        icon={<Ionicons name="close-circle-outline" size={29} color={theme.colors.textDestructive} />}
                        onPress={rejectGate}
                        loading={rejecting}
                        disabled={approving || rejecting}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {job.sessionId && (
                <ItemGroup>
                    <Item
                        title={t('run.openSession')}
                        icon={<Ionicons name="open-outline" size={29} color={theme.colors.button.primary.background} />}
                        onPress={() => router.push(`/session/${job.sessionId}` as any)}
                    />
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
