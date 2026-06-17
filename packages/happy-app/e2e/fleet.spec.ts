import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';

// E02 fleet-dashboard smoke. The authed app syncs the account's real sessions from the relay, so we
// assert the fleet SHELL renders (the section that hosts the session list + the collapse "Earlier"
// toggle) rather than any specific session content — safe and deterministic, never seeds the relay.

const machineId = testMachineId();

test.describe('fleet dashboard @e2e', () => {
    test.skip(!machineId, 'no credential (globalSetup did not run) — boot.spec covers the anon smoke');

    test('TC-E02-S01: authed home mounts the fleet shell without fatal errors', async ({ authedPage }) => {
        const errors: string[] = [];
        authedPage.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        authedPage.on('pageerror', (e) => errors.push(String(e)));

        await authedPage.goto('/');
        await expect(authedPage.locator('#root')).toBeVisible();
        // The fleet shell's New-session entry is present regardless of how many sessions exist.
        await expect(authedPage.getByText('New session', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

        const fatal = errors.filter((e) => /Cannot read|undefined is not|TypeError|is not a function/i.test(e));
        expect(fatal, `fatal console/page errors:\n${fatal.join('\n')}`).toHaveLength(0);
    });
});
