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

        // D-E10-21: the token field is multiline only on native; on web it is a single-line
        // secureTextEntry, which RN-Web renders as <input type="password"> — real masking on web
        // (the setup-token is sensitive, AC-7 token-hygiene).
        const tag = await token.evaluate((el) => el.tagName.toLowerCase());
        expect(tag, 'web renders the token field as a single-line input (masked)').toBe('input');
        const inputType = await token.evaluate((el) => (el as HTMLInputElement).type);
        expect(inputType, 'web token input is type=password (masked)').toBe('password');

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
