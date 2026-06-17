import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';

// TC-E10-U04: account-migrate multi-select remap.
// Needs RUNNING sessions per account on the machine — that requires real session spawns (QR-auth +
// real inference). Out of scope for the dummy-seed daemon; verified in Joshua's app-runbook.

const machineId = testMachineId();

test.describe('account-migrate screen @e2e', () => {
    test.skip(!machineId, 'no test machineId (globalSetup did not run — needs a credential)');

    test('TC-U04: screen renders (empty-state with no running sessions)', async ({ authedPage }) => {
        await authedPage.goto(`/machine/${machineId}/account-migrate`);
        // With no running sessions the empty-state shows; the live multi-select remap is the runbook part.
        await expect(authedPage.getByText('No running sessions on this machine.')).toBeVisible();
    });

    test.fixme('TC-U04-live: multi-select remap of running sessions (Joshua app-runbook)', async () => {
        // Requires spawned sessions bound to accounts; lives in the real-token runbook, not this suite.
    });
});
