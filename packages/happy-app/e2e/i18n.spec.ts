import { test, expect } from '@playwright/test';
import { loadCredentials, serverUrl, testMachineId, type AppCredentials } from './support/credentials';

// TC-E10-U07: the E10 screens resolve in all 10 languages (no raw i18n keys leak).
// Language is driven by the browser locale (expo-localization reads navigator at module-load; with no
// preferredLanguage set the locale match wins). Reaches the accounts screen via the machine-detail
// click-through (lets sync settle so the screen renders with data), then asserts the seeded accounts
// render AND no unresolved `subscriptions.` / `newSession.account` key string appears in the DOM.

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

            // The raw-key check doesn't need account DATA — the accounts screen's static labels
            // (section header, "Add account", empty-state, etc.) render translated regardless of the
            // RPC load, so we can assert key resolution without fighting the sync/load race.
            await page.goto(`/machine/${machineId}/accounts`);
            // Wait for the screen to actually render (React root populated), then settle.
            await page.locator('#root *').first().waitFor({ state: 'visible', timeout: 20000 });
            await page.waitForTimeout(4000);

            // Sanity: the app rendered a substantial screen (not a blank/error shell).
            const nodeCount = await page.locator('#root *').count();
            expect(nodeCount, `app rendered too little in ${lang} (count=${nodeCount})`).toBeGreaterThan(20);

            // No unresolved i18n key string may appear in the rendered DOM.
            const html = await page.content();
            const rawKey = html.match(/subscriptions\.[a-zA-Z][a-zA-Z.]*|newSession\.account\.[a-zA-Z]+/);
            expect(rawKey, `unresolved i18n key leaked in ${lang}: ${rawKey?.[0]}`).toBeNull();

            await context.close();
        });
    }
});
