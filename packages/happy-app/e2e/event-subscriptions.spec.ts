import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';
import { gotoUntilVisible } from './support/appReady';

// E04 event subscriptions + E05 untrustedInput, rendered against the isolated test daemon's seeded
// event_subscriptions (seedJobs.ts: one enabled git.commit subscription).

const machineId = testMachineId();

test.describe('event-subscriptions screen @e2e', () => {
    test.skip(!machineId, 'no test machineId (globalSetup did not run — needs a credential)');

    test('TC-E04-V01: list renders the seeded subscription (git.commit, enabled) + create entry', async ({ authedPage }) => {
        await gotoUntilVisible(authedPage, '/event-subscriptions', 'git.commit');
        await expect(authedPage.getByText('New subscription', { exact: true }).first()).toBeVisible();
        await expect(authedPage.getByText('Enabled', { exact: false }).first()).toBeVisible();
    });

    test('TC-E04-V02: new-subscription form renders fields incl. fixed git.commit + E05 untrustedInput', async ({ authedPage }) => {
        await gotoUntilVisible(authedPage, '/event-subscriptions/new', 'Event type');
        // git.commit is fixed (non-editable) with its hint.
        await expect(authedPage.getByText('Only git.commit is supported in this version.', { exact: true })).toBeVisible();
        for (const label of ['Match key', 'Directory', 'Prompt', 'Tier', 'Preset', 'Disposition topic', 'Untrusted input']) {
            await expect(authedPage.getByText(label, { exact: true })).toBeVisible();
        }
        await expect(authedPage.getByText('Yes', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('No', { exact: true })).toBeVisible();
    });
});
