import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';

// TC-E10-U06: burn-policy section on the accounts screen.
// Seeded policy: enabled, order [A,B,C], threshold 0.9.

const machineId = testMachineId();

test.describe('burn-policy section @e2e', () => {
    test.skip(!machineId, 'no test machineId (globalSetup did not run — needs a credential)');

    test('TC-U06: renders enable toggle, threshold label, and ordered burn list', async ({ authedPage }) => {
        await authedPage.goto(`/machine/${machineId}/accounts`);

        await expect(authedPage.getByText('Burn policy', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Auto-switch accounts', { exact: true })).toBeVisible();
        // Seeded threshold 0.9 -> "Switch at 90% used".
        await expect(authedPage.getByText('Switch at 90% used')).toBeVisible();

        // Burn order: 1. A / 2. B / 3. C (1-indexed).
        await expect(authedPage.getByText('Burn order', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('1. A')).toBeVisible();
        await expect(authedPage.getByText('2. B')).toBeVisible();
        await expect(authedPage.getByText('3. C')).toBeVisible();

        // Reorder arrows are reachable by their accessibility label (RN-Web -> aria-label).
        await expect(authedPage.getByLabel('Move down').first()).toBeVisible();
        await expect(authedPage.getByLabel('Move up').last()).toBeVisible();
    });

    test('TC-U06b: reordering persists (move A down → 1. B)', async ({ authedPage }) => {
        await authedPage.goto(`/machine/${machineId}/accounts`);
        await expect(authedPage.getByText('1. A')).toBeVisible();
        // Move the first account (A) down one position.
        await authedPage.getByLabel('Move down').first().click();
        await expect(authedPage.getByText('1. B')).toBeVisible();
        await expect(authedPage.getByText('2. A')).toBeVisible();
        // Reload from the daemon to confirm it persisted via set-burn-policy.
        await authedPage.reload();
        await expect(authedPage.getByText('1. B')).toBeVisible();
    });
});
