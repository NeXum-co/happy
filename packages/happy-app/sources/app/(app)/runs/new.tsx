import * as React from 'react';
import { View, Text, TextInput, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useHappyAction } from '@/hooks/useHappyAction';
import { machineSubmitJob } from '@/sync/runOps';
import { Modal } from '@/modal';

type Tier = 'trusted' | 'supervised';

// Optional numeric field → number | undefined (empty stays unset so the daemon
// keeps its own default).
function parseOptionalNumber(value: string): number | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
}

function NewRunScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const onlineMachine = React.useMemo(() => machines.find(isMachineOnline) ?? null, [machines]);

    const [directory, setDirectory] = React.useState('');
    const [prompt, setPrompt] = React.useState('');
    const [tier, setTier] = React.useState<Tier>('supervised');
    const [preset, setPreset] = React.useState('local-qwen');
    const [budget, setBudget] = React.useState('');
    const [turns, setTurns] = React.useState('');
    const [timeoutMinutes, setTimeoutMinutes] = React.useState('');
    const [dispositionTopic, setDispositionTopic] = React.useState('');

    const [submitting, submit] = useHappyAction(async () => {
        if (!onlineMachine) {
            Modal.alert(t('common.error'), t('newSession.machineOffline'));
            return;
        }
        const timeoutMin = parseOptionalNumber(timeoutMinutes);
        await machineSubmitJob(onlineMachine.id, {
            directory: directory.trim(),
            prompt: prompt.trim(),
            tier,
            preset: preset.trim() || 'local-qwen',
            maxBudgetUsd: parseOptionalNumber(budget),
            maxTurns: parseOptionalNumber(turns),
            timeoutMs: timeoutMin !== undefined ? timeoutMin * 60000 : undefined,
            dispositionTopic: dispositionTopic.trim() || undefined,
        });
        router.back();
    });

    const canSubmit = !!onlineMachine && directory.trim().length > 0 && prompt.trim().length > 0 && !submitting;

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.inner}>
                <Text style={styles.label}>{t('run.fieldDirectory')}</Text>
                <TextInput
                    style={styles.input}
                    value={directory}
                    onChangeText={setDirectory}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="/path/to/project"
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('run.fieldPrompt')}</Text>
                <TextInput
                    style={[styles.input, styles.multiline]}
                    value={prompt}
                    onChangeText={setPrompt}
                    multiline
                    placeholder={t('run.promptPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('run.fieldTier')}</Text>
                <View style={styles.tierRow}>
                    <Pressable
                        style={[styles.tierChip, tier === 'supervised' && styles.tierChipActive]}
                        onPress={() => setTier('supervised')}
                    >
                        <Text style={[styles.tierChipText, tier === 'supervised' && styles.tierChipTextActive]}>
                            {t('run.tierSupervised')}
                        </Text>
                    </Pressable>
                    <Pressable
                        style={[styles.tierChip, tier === 'trusted' && styles.tierChipActive]}
                        onPress={() => setTier('trusted')}
                    >
                        <Text style={[styles.tierChipText, tier === 'trusted' && styles.tierChipTextActive]}>
                            {t('run.tierTrusted')}
                        </Text>
                    </Pressable>
                </View>

                <Text style={styles.label}>{t('run.fieldPreset')}</Text>
                <TextInput
                    style={styles.input}
                    value={preset}
                    onChangeText={setPreset}
                    autoCapitalize="none"
                    autoCorrect={false}
                />

                <Text style={styles.label}>{t('run.fieldBudget')}</Text>
                <TextInput
                    style={styles.input}
                    value={budget}
                    onChangeText={setBudget}
                    keyboardType="numeric"
                    placeholder="—"
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('run.fieldTurns')}</Text>
                <TextInput
                    style={styles.input}
                    value={turns}
                    onChangeText={setTurns}
                    keyboardType="numeric"
                    placeholder="—"
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('run.fieldTimeout')}</Text>
                <TextInput
                    style={styles.input}
                    value={timeoutMinutes}
                    onChangeText={setTimeoutMinutes}
                    keyboardType="numeric"
                    placeholder="—"
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('run.fieldDispositionTopic')}</Text>
                <TextInput
                    style={styles.input}
                    value={dispositionTopic}
                    onChangeText={setDispositionTopic}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t('run.dispositionTopicPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />
                <Text style={styles.hint}>{t('run.dispositionTopicHint')}</Text>

                {!onlineMachine && (
                    <Text style={styles.offline}>{t('newSession.machineOffline')}</Text>
                )}

                <Pressable
                    style={[styles.submit, !canSubmit && styles.submitDisabled]}
                    disabled={!canSubmit}
                    onPress={submit}
                >
                    {submitting ? (
                        <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text style={styles.submitText}>{t('run.submit')}</Text>
                    )}
                </Pressable>
            </View>
        </ScrollView>
    );
}

export default React.memo(NewRunScreen);

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    content: {
        paddingVertical: 16,
    },
    inner: {
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: 16,
        gap: 8,
    },
    label: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        marginTop: 12,
    },
    hint: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 4,
    },
    input: {
        backgroundColor: theme.colors.input.background,
        color: theme.colors.text,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 15,
    },
    multiline: {
        minHeight: 96,
        textAlignVertical: 'top',
    },
    tierRow: {
        flexDirection: 'row',
        gap: 8,
    },
    tierChip: {
        flex: 1,
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingVertical: 10,
        alignItems: 'center',
    },
    tierChipActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    tierChipText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
    },
    tierChipTextActive: {
        color: theme.colors.button.primary.tint,
    },
    offline: {
        color: theme.colors.status.disconnected,
        fontSize: 13,
        marginTop: 12,
    },
    submit: {
        marginTop: 24,
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: 10,
        paddingVertical: 14,
        alignItems: 'center',
    },
    submitDisabled: {
        opacity: 0.4,
    },
    submitText: {
        color: theme.colors.button.primary.tint,
        fontSize: 16,
        fontWeight: '600',
    },
}));
