import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';

// TC-E10-U05: account picker on the new-session screen.
// The picker shows only for the claude agent AND only when the selected machine's vault has accounts.

const machineId = testMachineId();

test.describe('new-session account picker @e2e', () => {
    test.skip(!machineId, 'no test machineId (globalSetup did not run — needs a credential)');

    test('TC-U05: picker appears for claude + vault accounts, defaults to "Default account"', async ({ authedPage }) => {
        // Deep-link with the test machine preselected so the picker has the seeded vault.
        await authedPage.goto(`/new?machineId=${machineId}`);

        // The account config row shows "Default account" until one is chosen.
        const accountRow = authedPage.getByText('Default account', { exact: true });
        await expect(accountRow).toBeVisible();
        await accountRow.click();

        // Picker opens with title + the seeded accounts.
        await expect(authedPage.getByText('Subscription account', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('A', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('B', { exact: true })).toBeVisible();

        // Choosing an account updates the row label to that account.
        await authedPage.getByText('B', { exact: true }).click();
        await expect(authedPage.getByText('B', { exact: true })).toBeVisible();
    });
});
