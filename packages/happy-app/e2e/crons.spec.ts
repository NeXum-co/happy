import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';
import { gotoUntilVisible } from './support/appReady';

// E04 cron schedules + E05 untrustedInput, rendered against the isolated test daemon's seeded
// cron_schedules (seedJobs.ts: one enabled, far-future schedule).

const machineId = testMachineId();

test.describe('crons screen @e2e', () => {
    test.skip(!machineId, 'no test machineId (globalSetup did not run — needs a credential)');

    test('TC-E04-C01: list renders the seeded schedule (expr, enabled) + create entry', async ({ authedPage }) => {
        await gotoUntilVisible(authedPage, '/crons', '0 3 1 1 *');
        await expect(authedPage.getByText('Create schedule', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Enabled', { exact: false }).first()).toBeVisible();
    });

    test('TC-E04-C02: new-schedule form renders all fields incl. E05 dispositionTopic + untrustedInput', async ({ authedPage }) => {
        await gotoUntilVisible(authedPage, '/crons/new', 'Cron expression');
        for (const label of ['Cron expression', 'Directory', 'Prompt', 'Tier', 'Preset', 'Allowed tools', 'Disposition topic', 'Untrusted input']) {
            await expect(authedPage.getByText(label, { exact: true })).toBeVisible();
        }
        await expect(authedPage.getByText('Yes', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('No', { exact: true })).toBeVisible();
    });
});
