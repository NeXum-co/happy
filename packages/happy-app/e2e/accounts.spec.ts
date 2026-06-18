import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';
import { openAccounts, gotoUntilVisible } from './support/appReady';

// TC-E10-U01 (navigate) + TC-E10-U02 (list + UsageBar fail-soft + actions).
// Data comes from the isolated test daemon (seeded A default / B / C, dummy tokens -> usage unknown).

const machineId = testMachineId();

test.describe('accounts screen @e2e', () => {
    test.skip(!machineId, 'no test machineId (globalSetup did not run — needs a credential)');

    test('TC-U01: machine detail → Subscriptions row navigates to accounts', async ({ authedPage }) => {
        await gotoUntilVisible(authedPage, `/machine/${machineId}`, 'Subscriptions');
        await authedPage.getByText('Subscriptions', { exact: true }).click();
        await expect(authedPage.getByText('Add account', { exact: true })).toBeVisible();
    });

    test('TC-U02: lists seeded accounts with default badge + fail-soft usage', async ({ authedPage }) => {
        await openAccounts(authedPage, machineId!, 'A');
        for (const name of ['A', 'B', 'C']) {
            await expect(authedPage.getByText(name, { exact: true })).toBeVisible();
        }
        // A is default.
        await expect(authedPage.getByText('Default', { exact: true }).first()).toBeVisible();
        // Dummy tokens never produced a real usage response -> fail-soft "Usage unknown", never a number.
        await expect(authedPage.getByText('Usage unknown').first()).toBeVisible();
        // Entry points present.
        await expect(authedPage.getByText('Add account', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Migrate running sessions', { exact: true })).toBeVisible();
    });

    test('TC-U02b: per-account action sheet offers set-default + remove (with confirm)', async ({ authedPage }) => {
        await openAccounts(authedPage, machineId!, 'B');
        // Open the action sheet for the non-default account B.
        await authedPage.getByText('B', { exact: true }).click();
        await expect(authedPage.getByText('Set as default', { exact: true })).toBeVisible();
        const remove = authedPage.getByText('Remove account', { exact: true });
        await expect(remove).toBeVisible();
        await remove.click();
        // Destructive confirm, not an immediate delete.
        await expect(authedPage.getByText('Remove account?', { exact: true })).toBeVisible();
        await authedPage.getByText('Cancel', { exact: true }).click();
        // B still present after cancel.
        await expect(authedPage.getByText('B', { exact: true })).toBeVisible();
    });
});
