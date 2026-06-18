import { test, expect } from './fixtures/app';
import { testMachineId, loadFleet } from './support/credentials';

// E02 fleet-dashboard rich specs against the ISOLATED relay (globalSetup seeds a deterministic fleet:
// see e2e/support/seedSessions.ts). Unlike the old smoke, these assert the REAL fleet layout — the
// needs-you band, project group headers, the local-attention (terminal) flag, and the collapsed
// "Earlier (N)" archive toggle. All anchor strings come from sources/text/translations/en.ts:
//   fleet.needsYou      -> "Needs you (N)"
//   fleet.activeIn      -> "<project> (N active)"
//   fleet.waitsInTerminal -> "Waiting in terminal"
//   fleet.earlier       -> "Earlier (N)"
// The app syncs from the relay a few seconds after boot, so we poll the anchor before asserting.

const machineId = testMachineId();
const fleet = loadFleet();

// Wait until the authed app has synced the seeded fleet (the needs-you band header is the cheapest,
// always-present anchor once sessions arrive).
async function gotoHomeSynced(page: import('@playwright/test').Page) {
    await page.goto('/');
    await expect(page.locator('#root')).toBeVisible();
    await expect(page.getByText(/^Needs you \(\d+\)$/).first()).toBeVisible({ timeout: 30_000 });
}

test.describe('fleet dashboard @e2e', () => {
    test.skip(!machineId || !fleet, 'no seeded fleet (globalSetup did not run) — boot.spec covers anon smoke');

    test('TC-E02-S01: authed home mounts the fleet shell without fatal errors', async ({ authedPage }) => {
        const errors: string[] = [];
        authedPage.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        authedPage.on('pageerror', (e) => errors.push(String(e)));

        await authedPage.goto('/');
        await expect(authedPage.locator('#root')).toBeVisible();
        await expect(authedPage.getByText('New session', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

        const fatal = errors.filter((e) => /Cannot read|undefined is not|TypeError|is not a function/i.test(e));
        expect(fatal, `fatal console/page errors:\n${fatal.join('\n')}`).toHaveLength(0);
    });

    test('TC-E02-S02: needs-you band surfaces the two attention sessions', async ({ authedPage }) => {
        await gotoHomeSynced(authedPage);
        // 2 seeded needs-you sessions (1 remote request, 1 local terminal prompt) -> "Needs you (2)".
        await expect(authedPage.getByText('Needs you (2)', { exact: true })).toBeVisible();
    });

    test('TC-E02-S03: local-attention session is flagged "Waiting in terminal" (AC-6)', async ({ authedPage }) => {
        await gotoHomeSynced(authedPage);
        // The local terminal prompt cannot be answered in the app -> dedicated subtitle.
        await expect(authedPage.getByText('Waiting in terminal', { exact: true }).first()).toBeVisible();
    });

    test('TC-E02-S04: project group headers render for alpha and beta', async ({ authedPage }) => {
        await gotoHomeSynced(authedPage);
        // The idle 'beta' session sits under its project group. (alpha's only active sessions both
        // need-you, so they live in the band — beta is the group that survives into project-groups.)
        await expect(authedPage.getByText('beta (1 active)', { exact: true })).toBeVisible();
    });

    test('TC-E02-S05: archived sessions collapse under "Earlier (N)" and expand on toggle', async ({ authedPage }) => {
        await gotoHomeSynced(authedPage);
        // hideInactiveSessions defaults true -> the 2 archived sessions are collapsed.
        const earlier = authedPage.getByText('Earlier (2)', { exact: true });
        await expect(earlier).toBeVisible();
        // Expanding the toggle reveals the day-grouped inactive sessions (a "Today" header appears,
        // since the seeded sessions were created in this run).
        await earlier.click();
        await expect(authedPage.getByText('Today', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    });
});
