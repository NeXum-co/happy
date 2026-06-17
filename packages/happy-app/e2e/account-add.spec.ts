import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';

// TC-E10-U03: add-account form + validation + token-field behaviour.

const machineId = testMachineId();

test.describe('account-add screen @e2e @security', () => {
    test.skip(!machineId, 'no test machineId (globalSetup did not run — needs a credential)');

    test('TC-U03: form renders, validates empty input', async ({ authedPage }) => {
        await authedPage.goto(`/machine/${machineId}/account-add`);

        const name = authedPage.getByPlaceholder('e.g. work, personal');
        const token = authedPage.getByPlaceholder('Paste the claude setup-token here');
        await expect(name).toBeVisible();
        await expect(token).toBeVisible();

        // The token field is multiline + secureTextEntry. On native that masks; on web (secondary
        // platform) RN-Web renders multiline as a <textarea>, which cannot mask — so the setup-token
        // is visible as typed on web. Documented platform limitation (see e2e-results / handover).
        const tag = await token.evaluate((el) => el.tagName.toLowerCase());
        expect(tag, 'web renders the multiline token field as a textarea (no masking on web)').toBe('textarea');

        // Empty submit -> name-required validation error (Modal.alert), no navigation.
        await authedPage.getByText('Add account', { exact: true }).last().click();
        await expect(authedPage.getByText('Enter a name for this account.')).toBeVisible();
        await authedPage.getByText('OK', { exact: true }).click(); // dismiss the alert

        // Name only, empty token -> token-required error.
        await name.fill('e2e-temp');
        await authedPage.getByText('Add account', { exact: true }).last().click();
        await expect(authedPage.getByText('Paste the setup token.')).toBeVisible();
        await authedPage.getByText('OK', { exact: true }).click();
    });
});
