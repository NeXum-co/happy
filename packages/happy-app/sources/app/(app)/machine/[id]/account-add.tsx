import React, { memo, useState, useCallback } from 'react';
import { View, TextInput, ScrollView } from 'react-native';
import { Text } from '@/components/StyledText';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Switch } from '@/components/Switch';
import { RoundButton } from '@/components/RoundButton';
import { Modal } from '@/modal';
import { useHappyAction } from '@/hooks/useHappyAction';
import { machineAddAccount } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { layout } from '@/components/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

// E10 — add a Claude subscription to this machine's vault via paste-token
// (D-E10-17, Joshua-keuze). The user runs `claude setup-token` on the machine,
// logs in, and pastes the printed token here. It rides the machine-encrypted
// RPC channel into the vault and is NEVER logged (security.md).
export default memo(function AccountAddScreen() {
    const { theme } = useUnistyles();
    const { id: machineId } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const [name, setName] = useState('');
    const [token, setToken] = useState('');
    const [makeDefault, setMakeDefault] = useState(false);

    const [adding, doAdd] = useHappyAction(useCallback(async () => {
        const trimmedName = name.trim();
        const trimmedToken = token.trim();
        if (!trimmedName) {
            Modal.alert(t('common.error'), t('subscriptions.nameRequired'));
            return;
        }
        if (!trimmedToken) {
            Modal.alert(t('common.error'), t('subscriptions.tokenRequired'));
            return;
        }
        await machineAddAccount(machineId!, trimmedName, trimmedToken, makeDefault);
        await sync.refreshMachines().catch(() => {});
        router.back();
    }, [machineId, name, token, makeDefault, router]));

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('subscriptions.addTitle'), headerBackTitle: t('machine.back') }} />
            <ScrollView
                style={styles.container}
                contentContainerStyle={[styles.content, { maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }]}
                keyboardShouldPersistTaps="handled"
            >
                <ItemGroup footer={t('subscriptions.addInstructions')}>
                    <Item title={t('subscriptions.addInstructionsTitle')} subtitle={t('subscriptions.addInstructionsRun')} subtitleLines={0} showChevron={false} />
                </ItemGroup>

                <View style={styles.field}>
                    <Text style={styles.label}>{t('subscriptions.nameLabel')}</Text>
                    <TextInput
                        style={styles.input}
                        value={name}
                        onChangeText={setName}
                        placeholder={t('subscriptions.namePlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </View>

                <View style={styles.field}>
                    <Text style={styles.label}>{t('subscriptions.tokenLabel')}</Text>
                    <TextInput
                        style={[styles.input, styles.tokenInput]}
                        value={token}
                        onChangeText={setToken}
                        placeholder={t('subscriptions.tokenPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline
                        secureTextEntry
                    />
                </View>

                <ItemGroup>
                    <Item
                        title={t('subscriptions.makeDefault')}
                        rightElement={<Switch value={makeDefault} onValueChange={setMakeDefault} />}
                        showChevron={false}
                    />
                </ItemGroup>

                <View style={styles.submit}>
                    <RoundButton title={t('subscriptions.addButton')} loading={adding} onPress={doAdd} />
                </View>
            </ScrollView>
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        paddingBottom: 48,
    },
    field: {
        paddingHorizontal: 16,
        marginTop: 16,
    },
    label: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        marginBottom: 8,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    input: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        fontSize: 16,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    tokenInput: {
        minHeight: 96,
        textAlignVertical: 'top',
        fontFamily: 'Menlo',
        fontSize: 13,
    },
    submit: {
        paddingHorizontal: 16,
        marginTop: 24,
    },
}));
