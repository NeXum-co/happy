import { test as base, expect, type Page } from '@playwright/test';
import { loadCredentials, serverUrl, testMachineId, type AppCredentials } from '../support/credentials';

interface AppFixtures {
    /** Relay URL injected into the app, and the (optional) credential / machineId for this run. */
    appEnv: { serverUrl: string; creds: AppCredentials | null; machineId: string | null };
    /** A page that boots the app pointed at the relay but NOT logged in (login/QR screen). */
    anonPage: Page;
    /** A page that boots the app already logged in. Skips the test if no credential is available. */
    authedPage: Page;
}

/** Inject the relay URL before any app script runs (window.__HAPPY_CONFIG__ is read by serverConfig.ts). */
async function injectServerUrl(page: Page, url: string) {
    await page.addInitScript((u) => {
        (globalThis as any).__HAPPY_CONFIG__ = { ...(globalThis as any).__HAPPY_CONFIG__, serverUrl: u };
    }, url);
}

/** Inject the app auth credential into localStorage before boot (tokenStorage.ts key 'auth_credentials'). */
async function injectCredentials(page: Page, creds: AppCredentials) {
    await page.addInitScript((c) => {
        try {
            localStorage.setItem('auth_credentials', JSON.stringify(c));
        } catch {}
    }, creds);
}

export const test = base.extend<AppFixtures>({
    appEnv: async ({}, use) => {
        await use({ serverUrl: serverUrl(), creds: loadCredentials(), machineId: testMachineId() });
    },

    anonPage: async ({ page, appEnv }, use) => {
        await injectServerUrl(page, appEnv.serverUrl);
        await use(page);
    },

    authedPage: async ({ page, appEnv }, use) => {
        test.skip(!appEnv.creds, 'No app credential (e2e/.auth/credentials.json or HAPPY_E2E_* env). See e2e/README.md.');
        await injectServerUrl(page, appEnv.serverUrl);
        await injectCredentials(page, appEnv.creds!);
        await use(page);
    },
});

export { expect };
