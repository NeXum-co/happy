import * as React from 'react';
import { View, Text, TextInput, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useHappyAction } from '@/hooks/useHappyAction';
import { machineSubmitCron } from '@/sync/cronOps';
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

// Optional comma/space separated tool list → string[] | undefined.
function parseOptionalTools(value: string): string[] | undefined {
    const tools = value
        .split(/[,\s]+/)
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0);
    return tools.length > 0 ? tools : undefined;
}

// Light client-side check: a standard cron expression has five whitespace-separated
// fields. The daemon still performs the authoritative validation.
function hasFiveCronFields(value: string): boolean {
    return value.trim().split(/\s+/).filter((field) => field.length > 0).length >= 5;
}

function NewCronScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const onlineMachine = React.useMemo(() => machines.find(isMachineOnline) ?? null, [machines]);

    const [cronExpr, setCronExpr] = React.useState('');
    const [directory, setDirectory] = React.useState('');
    const [prompt, setPrompt] = React.useState('');
    const [tier, setTier] = React.useState<Tier>('supervised');
    const [preset, setPreset] = React.useState('local-qwen');
    const [budget, setBudget] = React.useState('');
    const [turns, setTurns] = React.useState('');
    const [timeoutMinutes, setTimeoutMinutes] = React.useState('');
    const [allowedTools, setAllowedTools] = React.useState('');
    const [dispositionTopic, setDispositionTopic] = React.useState('');
    const [untrustedInput, setUntrustedInput] = React.useState(false);

    const cronExprInvalid = cronExpr.trim().length > 0 && !hasFiveCronFields(cronExpr);

    const [submitting, submit] = useHappyAction(async () => {
        if (!onlineMachine) {
            Modal.alert(t('common.error'), t('newSession.machineOffline'));
            return;
        }
        const timeoutMin = parseOptionalNumber(timeoutMinutes);
        await machineSubmitCron(onlineMachine.id, {
            cronExpr: cronExpr.trim(),
            directory: directory.trim(),
            prompt: prompt.trim(),
            tier,
            preset: preset.trim() || 'local-qwen',
            maxBudgetUsd: parseOptionalNumber(budget),
            maxTurns: parseOptionalNumber(turns),
            timeoutMs: timeoutMin !== undefined ? timeoutMin * 60000 : undefined,
            allowedTools: parseOptionalTools(allowedTools),
            dispositionTopic: dispositionTopic.trim() || undefined,
            untrustedInput: untrustedInput || undefined,
        });
        Modal.alert(t('common.success'), t('cron.submitSuccess'), [
            { text: t('common.ok'), onPress: () => router.back() },
        ]);
    });

    const canSubmit = !!onlineMachine
        && cronExpr.trim().length > 0
        && !cronExprInvalid
        && directory.trim().length > 0
        && prompt.trim().length > 0
        && !submitting;

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.inner}>
                {!onlineMachine && (
                    <View style={styles.offlineBanner}>
                        <Text style={styles.offlineBannerText}>{t('newSession.machineOffline')}</Text>
                    </View>
                )}

                <Text style={styles.label}>{t('cron.fieldCronExpr')}</Text>
                <TextInput
                    style={styles.input}
                    value={cronExpr}
                    onChangeText={setCronExpr}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t('cron.cronExprPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />
                <Text style={[styles.hint, cronExprInvalid && styles.hintError]}>
                    {cronExprInvalid ? t('cron.cronExprInvalid') : t('cron.cronExprHint')}
                </Text>

                <Text style={styles.label}>{t('cron.fieldDirectory')}</Text>
                <TextInput
                    style={styles.input}
                    value={directory}
                    onChangeText={setDirectory}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t('common.directoryPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('cron.fieldPrompt')}</Text>
                <TextInput
                    style={[styles.input, styles.multiline]}
                    value={prompt}
                    onChangeText={setPrompt}
                    multiline
                    placeholder={t('cron.promptPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('cron.fieldTier')}</Text>
                <View style={styles.tierRow}>
                    <Pressable
                        style={[styles.tierChip, tier === 'supervised' && styles.tierChipActive]}
                        onPress={() => setTier('supervised')}
                        accessibilityRole="button"
                        accessibilityState={{ selected: tier === 'supervised' }}
                        accessibilityLabel={t('cron.tierSupervised')}
                    >
                        <Text style={[styles.tierChipText, tier === 'supervised' && styles.tierChipTextActive]}>
                            {t('cron.tierSupervised')}
                        </Text>
                    </Pressable>
                    <Pressable
                        style={[styles.tierChip, tier === 'trusted' && styles.tierChipActive]}
                        onPress={() => setTier('trusted')}
                        accessibilityRole="button"
                        accessibilityState={{ selected: tier === 'trusted' }}
                        accessibilityLabel={t('cron.tierTrusted')}
                    >
                        <Text style={[styles.tierChipText, tier === 'trusted' && styles.tierChipTextActive]}>
                            {t('cron.tierTrusted')}
                        </Text>
                    </Pressable>
                </View>

                <Text style={styles.label}>{t('cron.fieldPreset')}</Text>
                <TextInput
                    style={styles.input}
                    value={preset}
                    onChangeText={setPreset}
                    autoCapitalize="none"
                    autoCorrect={false}
                />

                <Text style={styles.label}>{t('cron.fieldBudget')}</Text>
                <TextInput
                    style={styles.input}
                    value={budget}
                    onChangeText={setBudget}
                    keyboardType="numeric"
                    placeholder={t('common.emptyPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('cron.fieldTurns')}</Text>
                <TextInput
                    style={styles.input}
                    value={turns}
                    onChangeText={setTurns}
                    keyboardType="numeric"
                    placeholder={t('common.emptyPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('cron.fieldTimeout')}</Text>
                <TextInput
                    style={styles.input}
                    value={timeoutMinutes}
                    onChangeText={setTimeoutMinutes}
                    keyboardType="numeric"
                    placeholder={t('common.emptyPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />

                <Text style={styles.label}>{t('cron.fieldAllowedTools')}</Text>
                <TextInput
                    style={styles.input}
                    value={allowedTools}
                    onChangeText={setAllowedTools}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t('cron.allowedToolsPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />
                <Text style={styles.hint}>{t('cron.allowedToolsHint')}</Text>

                <Text style={styles.label}>{t('cron.fieldDispositionTopic')}</Text>
                <TextInput
                    style={styles.input}
                    value={dispositionTopic}
                    onChangeText={setDispositionTopic}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t('cron.dispositionTopicPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                />
                <Text style={styles.hint}>{t('cron.dispositionTopicHint')}</Text>

                <Text style={styles.label}>{t('cron.fieldUntrustedInput')}</Text>
                <View style={styles.tierRow}>
                    <Pressable
                        style={[styles.tierChip, !untrustedInput && styles.tierChipActive]}
                        onPress={() => setUntrustedInput(false)}
                    >
                        <Text style={[styles.tierChipText, !untrustedInput && styles.tierChipTextActive]}>
                            {t('common.no')}
                        </Text>
                    </Pressable>
                    <Pressable
                        style={[styles.tierChip, untrustedInput && styles.tierChipActive]}
                        onPress={() => setUntrustedInput(true)}
                    >
                        <Text style={[styles.tierChipText, untrustedInput && styles.tierChipTextActive]}>
                            {t('common.yes')}
                        </Text>
                    </Pressable>
                </View>
                <Text style={styles.hint}>{t('cron.untrustedInputHint')}</Text>

                <Pressable
                    style={[styles.submit, !canSubmit && styles.submitDisabled]}
                    disabled={!canSubmit}
                    onPress={submit}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canSubmit, busy: submitting }}
                    accessibilityLabel={t('cron.submit')}
                >
                    {submitting ? (
                        <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                    ) : (
                        <Text style={styles.submitText}>{t('cron.submit')}</Text>
                    )}
                </Pressable>
            </View>
        </ScrollView>
    );
}

export default React.memo(NewCronScreen);

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
    hintError: {
        color: theme.colors.status.disconnected,
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
    offlineBanner: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 4,
    },
    offlineBannerText: {
        color: theme.colors.status.disconnected,
        fontSize: 13,
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
