import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SessionRowData } from '@/sync/storage';
import { projectKeyFromPath } from '@/sync/projectKey';
import { StatusDot } from './StatusDot';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { t } from '@/text';

interface NeedsYouBandProps {
    sessions: SessionRowData[];
    selectedSessionId?: string;
}

/**
 * Fleet "needs you" band (E02): all sessions waiting on a permission answer,
 * across all projects, pinned above the project groups.
 */
export const NeedsYouBand = React.memo(({ sessions, selectedSessionId }: NeedsYouBandProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <View style={styles.band}>
            <View style={styles.bandHeader}>
                <Ionicons name="alert-circle" size={14} color={theme.colors.box.warning.text} />
                <Text style={styles.bandHeaderText}>
                    {t('fleet.needsYou', { count: sessions.length })}
                </Text>
            </View>
            {sessions.map((session, index) => (
                <NeedsYouRow
                    key={session.id}
                    session={session}
                    selected={session.id === selectedSessionId}
                    showBorder={index < sessions.length - 1}
                />
            ))}
        </View>
    );
});

const NeedsYouRow = React.memo(({ session, selected, showBorder }: {
    session: SessionRowData;
    selected: boolean;
    showBorder: boolean;
}) => {
    const styles = stylesheet;
    const navigateToSession = useNavigateToSession();

    const projectKey = session.path
        ? projectKeyFromPath(session.path, session.homeDir)
        : null;

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    return (
        <Pressable
            style={[styles.row, showBorder && styles.rowWithBorder, selected && styles.rowSelected]}
            onPress={handlePress}
        >
            <View style={styles.rowDot}>
                <StatusDot color="#FF9500" isPulsing={true} />
            </View>
            <View style={styles.rowContent}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                    {projectKey ? `${projectKey} · ${session.name}` : session.name}
                </Text>
                <Text style={styles.rowSubtitle} numberOfLines={1}>
                    {t('status.permissionRequired')}
                </Text>
            </View>
        </Pressable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    band: {
        marginHorizontal: 16,
        marginTop: 8,
        marginBottom: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.box.warning.border,
        backgroundColor: theme.colors.box.warning.background,
        overflow: 'hidden',
    },
    bandHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 6,
    },
    bandHeaderText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.box.warning.text,
        ...Typography.default('semiBold'),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    rowWithBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.box.warning.border,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    rowDot: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 8,
    },
    rowContent: {
        flex: 1,
        minWidth: 0,
    },
    rowTitle: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    rowSubtitle: {
        fontSize: 12,
        color: theme.colors.box.warning.text,
        marginTop: 1,
        ...Typography.default(),
    },
}));
