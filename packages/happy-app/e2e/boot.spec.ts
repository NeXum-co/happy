import { test, expect } from './fixtures/app';

// Slice A smoke: proves the committed harness boots the exported web build against the relay.
// Credential-free — runs in CI without any secret.

test.describe('app boot @smoke', () => {
    test('serves the exported SPA and mounts the React root', async ({ anonPage }) => {
        await anonPage.goto('/');
        // The Expo single-output SPA mounts into #root.
        await expect(anonPage.locator('#root')).toBeVisible();
        // Bundle executed (something rendered inside root), not just the empty shell.
        await expect.poll(async () => (await anonPage.locator('#root *').count()), {
            timeout: 30_000,
        }).toBeGreaterThan(0);
    });

    test('without a credential, shows the unauthenticated entry (no crash)', async ({ anonPage }) => {
        const errors: string[] = [];
        anonPage.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        anonPage.on('pageerror', (e) => errors.push(String(e)));

        await anonPage.goto('/');
        await expect(anonPage.locator('#root')).toBeVisible();
        // Give the init sequence (fonts + sodium.ready + TokenStorage) time to settle.
        await anonPage.waitForTimeout(4000);

        // No auth credential injected -> the app must not be in an authed/fleet state.
        // It should not have thrown a fatal page error.
        const fatal = errors.filter((e) => /Cannot read|undefined is not|TypeError|is not a function/i.test(e));
        expect(fatal, `fatal console/page errors:\n${fatal.join('\n')}`).toHaveLength(0);
    });
});
