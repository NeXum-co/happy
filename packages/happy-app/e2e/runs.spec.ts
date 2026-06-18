import { test, expect } from './fixtures/app';
import { testMachineId } from './support/credentials';
import { gotoUntilVisible } from './support/appReady';

// E04 autonomous runs + E05 gate verdict, rendered against the isolated test daemon's seeded
// jobStore (seedJobs.ts): a gate-parked needs-attention job, a gate-resolved succeeded job, and a
// failed job. The /runs screens pick the first online machine (the test daemon).

const machineId = testMachineId();

test.describe('runs screen @e2e', () => {
    test.skip(!machineId, 'no test machineId (globalSetup did not run — needs a credential)');

    test('TC-E04-R01: list renders seeded jobs with status, tier and cost', async ({ authedPage }) => {
        // Gate-parked job sorts first (needs-attention). Anchor on its prompt to prove jobs loaded.
        await gotoUntilVisible(authedPage, '/runs', 'Refactor the authentication module to use the new token store');
        // Submit entry point is always present once a machine is online.
        await expect(authedPage.getByText('Submit job', { exact: true })).toBeVisible();
        // All three seeded jobs render by their (untruncated) prompts.
        await expect(authedPage.getByText('Update the changelog for the 1.2 release', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Run the database migration on the staging schema', { exact: true })).toBeVisible();
        // Status + tier subtitle and cost line for the succeeded job.
        await expect(authedPage.getByText('Needs you', { exact: false }).first()).toBeVisible();
        await expect(authedPage.getByText('Cost: $0.42', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Cost: $0.10', { exact: true })).toBeVisible();
    });

    test('TC-E04-R02: new-job form renders all fields incl. E05 dispositionTopic + untrustedInput', async ({ authedPage }) => {
        await gotoUntilVisible(authedPage, '/runs/new', 'Prompt');
        for (const label of ['Directory', 'Prompt', 'Tier', 'Preset', 'Disposition topic', 'Untrusted input']) {
            await expect(authedPage.getByText(label, { exact: true })).toBeVisible();
        }
        // Tier chips and the untrusted Yes/No toggle.
        await expect(authedPage.getByText('Trusted (autonomous)', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Supervised (asks)', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Yes', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('No', { exact: true })).toBeVisible();
    });

    test('TC-E04-R03 / TC-E05-G01: gate-parked detail shows verdict rows + untrusted + approve/reject', async ({ authedPage }) => {
        await gotoUntilVisible(authedPage, '/runs/seed-job-gate', 'This job needs your approval');
        // E05 gate verdict (UX-002 localized labels, not raw enums).
        await expect(authedPage.getByText('Gate decision', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Held for approval', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Confidence', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Insufficient data', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Gate reason', { exact: true })).toBeVisible();
        // untrustedInput row + topic.
        await expect(authedPage.getByText('Untrusted input', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('architecture/api-design', { exact: true })).toBeVisible();
        // Approve / reject actions for a gate:* parked job.
        await expect(authedPage.getByText('Approve', { exact: true })).toBeVisible();
        await expect(authedPage.getByText('Reject', { exact: true })).toBeVisible();
    });

    test('TC-E05-G03: reject round-trip (machineResolveGate) drives the parked job to dead', async ({ authedPage }) => {
        // Dedicated parked job; reject marks it dead with NO spawn attempt (deterministic).
        await gotoUntilVisible(authedPage, '/runs/seed-job-gate2', 'This job needs your approval');
        await expect(authedPage.getByText('Reject', { exact: true })).toBeVisible();
        // List action opens the destructive confirm dialog; the modal mounts last in the DOM.
        await authedPage.getByText('Reject', { exact: true }).first().click();
        await expect(authedPage.getByText('Reject this job? It will be marked dead.', { exact: true })).toBeVisible();
        await authedPage.getByText('Reject', { exact: true }).last().click();
        // The 2s poll refreshes the now-dead job: status flips to Dead, the escalation + actions vanish.
        await expect(authedPage.getByText('Dead', { exact: true })).toBeVisible({ timeout: 15000 });
        await expect(authedPage.getByText('This job needs your approval', { exact: true })).toHaveCount(0);
        await expect(authedPage.getByText('Approve', { exact: true })).toHaveCount(0);
    });

    test('TC-E05-G02 (UX-006): resolved job shows the topic but hides the gate-verdict rows', async ({ authedPage }) => {
        await gotoUntilVisible(authedPage, '/runs/seed-job-ok', 'Update the changelog for the 1.2 release');
        // Topic still shown for the resolved job.
        await expect(authedPage.getByText('process/docs', { exact: true })).toBeVisible();
        // UX-006: once gateResolved, the "why held" rows are gone.
        await expect(authedPage.getByText('Gate decision', { exact: true })).toHaveCount(0);
        await expect(authedPage.getByText('Gate reason', { exact: true })).toHaveCount(0);
        // A succeeded job offers no approve/reject.
        await expect(authedPage.getByText('Approve', { exact: true })).toHaveCount(0);
    });
});
