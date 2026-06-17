import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';

// TC-E10-U03: add-account form + validation + token hygiene.

const machineId = testMachineId();

test.describe('account-add screen @e2e @security', () => {
    test.skip(!machineId, 'no test machineId (globalSetup did not run — needs a credential)');

    test('TC-U03: form renders, validates empty input, token field is masked', async ({ authedPage }) => {
        await authedPage.goto(`/machine/${machineId}/account-add`);

        const name = authedPage.getByPlaceholder('e.g. work, personal');
        const token = authedPage.getByPlaceholder('Paste the claude setup-token here');
        await expect(name).toBeVisible();
        await expect(token).toBeVisible();

        // Token field must be a secure/masked input (never plain text on screen).
        const tokenType = await token.getAttribute('type');
        expect(tokenType, 'token field should be masked (type=password)').toBe('password');

        // Empty submit -> validation error, no navigation.
        await authedPage.getByText('Add account', { exact: true }).click();
        await expect(authedPage.getByText('Enter a name for this account.')).toBeVisible();

        // Name only, empty token -> token-required error.
        await name.fill('e2e-temp');
        await authedPage.getByText('Add account', { exact: true }).click();
        await expect(authedPage.getByText('Paste the setup token.')).toBeVisible();
    });
});
