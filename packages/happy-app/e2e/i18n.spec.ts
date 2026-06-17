import { test, expect } from '@playwright/test';
import { loadCredentials, serverUrl, testMachineId, type AppCredentials } from './support/credentials';

// TC-E10-U07: the E10 screens resolve in all 10 languages (no raw i18n keys leak).
// Language is driven by the browser locale (expo-localization reads navigator at module-load; with no
// preferredLanguage set the locale match wins). We assert the seeded accounts render AND no unresolved
// `subscriptions.` / `newSession.account` key string appears in the DOM, for every language.

const LOCALES: Record<string, string> = {
    en: 'en-US', ru: 'ru-RU', pl: 'pl-PL', es: 'es-ES', ca: 'ca-ES',
    it: 'it-IT', pt: 'pt-PT', ja: 'ja-JP', 'zh-Hans': 'zh-Hans-CN', 'zh-Hant': 'zh-Hant-TW',
};

const creds = loadCredentials();
const machineId = testMachineId();

test.describe('i18n on E10 screens @e2e @i18n', () => {
    test.skip(!creds || !machineId, 'needs a credential + test daemon (globalSetup).');

    for (const [lang, locale] of Object.entries(LOCALES)) {
        test(`TC-U07[${lang}]: accounts screen resolves, no raw keys`, async ({ browser }) => {
            const context = await browser.newContext({ locale });
            const page = await context.newPage();
            await page.addInitScript((u) => {
                (globalThis as any).__HAPPY_CONFIG__ = { ...(globalThis as any).__HAPPY_CONFIG__, serverUrl: u };
            }, serverUrl());
            await page.addInitScript((c: AppCredentials) => {
                try { localStorage.setItem('auth_credentials', JSON.stringify(c)); } catch {}
            }, creds!);

            await page.goto(`/machine/${machineId}/accounts`);
            // Seeded account names are language-agnostic — their presence means the screen rendered.
            await expect(page.getByText('A', { exact: true })).toBeVisible();

            const html = await page.content();
            const rawKey = html.match(/subscriptions\.[a-zA-Z.]+|newSession\.account\.[a-zA-Z]+/);
            expect(rawKey, `unresolved i18n key leaked in ${lang}: ${rawKey?.[0]}`).toBeNull();

            await context.close();
        });
    }
});
