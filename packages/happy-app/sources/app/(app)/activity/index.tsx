import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAllSessions } from '@/sync/storage';
import { useAuth } from '@/auth/AuthContext';
import { getSessionName } from '@/utils/sessionUtils';
import { getUsageForPeriod, calculateTotals, queryUsage } from '@/sync/apiUsage';
import { computeActivityLayout, ActivityRow, ProjectRollupRow } from '@/sync/activityLayout';
import { useHappyAction } from '@/hooks/useHappyAction';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Avatar } from '@/components/Avatar';
import { StatusDot } from '@/components/StatusDot';
import { ShimmerView } from '@/components/ShimmerView';
import { EmptyMainScreen } from '@/components/EmptyMainScreen';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';

type Period = 'today' | '7days' | '30days';

function formatDuration(durationMs: number): string {
    const totalMinutes = Math.round(durationMs / 60000);
    if (totalMinutes < 60) {
        return t('activity.durationMinutes', { count: totalMinutes });
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (minutes === 0) {
        return t('activity.durationHours', { count: hours });
    }
    return t('activity.durationHoursMinutes', { hours, minutes });
}

function formatCost(cost: number): string {
    return `$${cost.toFixed(2)}`;
}

function basename(path: string | null): string {
    if (!path) {
        return t('activity.unknownProject');
    }
    const segments = path.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : path;
}

export default React.memo(function ActivityScreen() {
    const { theme } = useUnistyles();
    const sessions = useAllSessions();
    const auth = useAuth();

    const [period, setPeriod] = React.useState<Period>('7days');
    const [totals, setTotals] = React.useState<{ totalTokens: number; totalCost: number }>({ totalTokens: 0, totalCost: 0 });
    const [usageBySession, setUsageBySession] = React.useState<Map<string, number>>(new Map());
    const [loaded, setLoaded] = React.useState(false);

    const [loading, loadData] = useHappyAction(React.useCallback(async () => {
        const credentials = auth.credentials;
        if (!credentials) {
            return;
        }

        const periodResponse = await getUsageForPeriod(credentials, period);
        const periodTotals = calculateTotals(periodResponse.usage ?? []);

        const startTime = periodResponse.usage?.[0]?.timestamp;
        const perSession = await Promise.all(
            sessions.map(async (session) => {
                const response = await queryUsage(credentials, {
                    sessionId: session.id,
                    startTime,
                    endTime: Math.floor(Date.now() / 1000),
                });
                const { totalCost } = calculateTotals(response.usage ?? []);
                return [session.id, totalCost] as const;
            }),
        );

        setTotals({ totalTokens: periodTotals.totalTokens, totalCost: periodTotals.totalCost });
        setUsageBySession(new Map(perSession));
        setLoaded(true);
    }, [auth.credentials, period, sessions]));

    React.useEffect(() => {
        loadData();
    }, [period]);

    const titleById = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const session of sessions) {
            map.set(session.id, getSessionName(session));
        }
        return map;
    }, [sessions]);

    const activity = React.useMemo(() => {
        return computeActivityLayout(sessions, {
            now: Date.now(),
            usageBySession,
            getTitle: (s) => titleById.get(s.id) ?? '',
        });
    }, [sessions, usageBySession, titleById]);

    const periods: Period[] = ['today', '7days', '30days'];
    const periodLabel: Record<Period, string> = {
        today: t('activity.today'),
        '7days': t('activity.last7days'),
        '30days': t('activity.last30days'),
    };

    if (!loaded && loading) {
        return (
            <View style={styles.shimmerContainer}>
                <ShimmerView style={styles.shimmerBlock}>
                    <View style={styles.shimmerInner} />
                </ShimmerView>
            </View>
        );
    }

    if (sessions.length === 0) {
        return <EmptyMainScreen />;
    }

    return (
        <ItemList contentContainerStyle={styles.content}>
            <View style={styles.periodWrapper}>
                <View style={styles.periodSelector}>
                    {periods.map((p) => (
                        <Pressable
                            key={p}
                            onPress={() => setPeriod(p)}
                            style={[styles.periodButton, period === p && styles.periodButtonActive]}
                        >
                            <Text style={[styles.periodText, period === p && styles.periodTextActive]}>
                                {periodLabel[p]}
                            </Text>
                        </Pressable>
                    ))}
                </View>
                <View style={styles.totalsRow}>
                    <View style={styles.totalCell}>
                        <Text style={styles.totalValue}>{totals.totalTokens.toLocaleString()}</Text>
                        <Text style={styles.totalLabel}>{t('activity.tokens')}</Text>
                    </View>
                    <View style={styles.totalCell}>
                        <Text style={styles.totalValue}>{formatCost(totals.totalCost)}</Text>
                        <Text style={styles.totalLabel}>{t('activity.cost')}</Text>
                    </View>
                </View>
            </View>

            <ItemGroup title={t('activity.perProject')}>
                {activity.projectRollup.map((row: ProjectRollupRow) => (
                    <Item
                        key={`${row.machineId}:${row.project}`}
                        title={basename(row.project)}
                        subtitle={t('activity.sessions', { count: row.count })}
                        detail={`${formatDuration(row.durationMs)} · ${formatCost(row.costUsd)}`}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {activity.dayGroups.map((group) => (
                <ItemGroup key={group.date} title={group.date}>
                    {group.sessions.map((row: ActivityRow) => (
                        <Item
                            key={row.id}
                            title={row.title}
                            subtitle={`${basename(row.project)}${row.machineId ? ` · ${row.machineId}` : ''}`}
                            detail={`${formatDuration(row.durationMs)} · ${formatCost(row.costUsd ?? 0)}`}
                            showChevron={false}
                            leftElement={
                                <View style={styles.avatarWrapper}>
                                    <Avatar id={row.machineId && row.project ? `${row.machineId}:${row.project}` : row.id} size={32} />
                                    <StatusDot
                                        color={row.active ? theme.colors.status.connected : theme.colors.status.disconnected}
                                        isPulsing={row.active}
                                        size={8}
                                        style={styles.statusDot}
                                    />
                                </View>
                            }
                        />
                    ))}
                </ItemGroup>
            ))}
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    content: {
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
    },
    shimmerContainer: {
        flex: 1,
        padding: 16,
        backgroundColor: theme.colors.groupped.background,
    },
    shimmerBlock: {
        borderRadius: 12,
        overflow: 'hidden',
    },
    shimmerInner: {
        height: 220,
        borderRadius: 12,
    },
    periodWrapper: {
        paddingTop: 16,
    },
    periodSelector: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        gap: 8,
    },
    periodButton: {
        flex: 1,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
    },
    periodButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    periodText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    periodTextActive: {
        color: theme.colors.button.primary.tint,
    },
    totalsRow: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 16,
        gap: 12,
    },
    totalCell: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: 'center',
        gap: 4,
    },
    totalValue: {
        ...Typography.default('semiBold'),
        fontSize: 20,
        color: theme.colors.text,
    },
    totalLabel: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    avatarWrapper: {
        width: 32,
        height: 32,
        position: 'relative',
    },
    statusDot: {
        position: 'absolute',
        bottom: -1,
        right: -1,
        borderWidth: 1.5,
        borderColor: theme.colors.surface,
    },
}));
