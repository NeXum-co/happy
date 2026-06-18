import { test, expect } from './fixtures/app';
import { loadFleet } from './support/credentials';

// E08 activity-dashboard rich specs against the ISOLATED relay. globalSetup seeds a fleet
// (seedSessions) AND per-session UsageReport rows (seedUsage), so these assert the REAL activity
// view against exact seeded numbers:
//   - period totals (tokens + cost) from POST /v1/usage/query           (AC-3)
//   - per-project rollup costs aggregated from the per-session queries   (AC-2)
//   - day-grouped sessions under today's calendar date                   (AC-1)
// Anchor strings come from sources/text/translations/en.ts (activity.*).

const fleet = loadFleet();

function localYmd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

test.describe('activity dashboard @e2e', () => {
    test.skip(!fleet || !fleet.usage, 'no seeded fleet+usage (globalSetup did not run)');

    test('TC-E08-A01: period totals show real seeded tokens + cost (AC-3)', async ({ authedPage }) => {
        const usage = fleet!.usage!;
        await authedPage.goto('/activity');
        await expect(authedPage.locator('#root')).toBeVisible();

        // Totals populate after the session store hydrates and the usage fetch resolves.
        await expect(authedPage.getByText(`$${usage.totalCost.toFixed(2)}`).first())
            .toBeVisible({ timeout: 30_000 });
        await expect(authedPage.getByText(usage.totalTokens.toLocaleString('en-US')).first())
            .toBeVisible();
        // Period selector is present.
        await expect(authedPage.getByText('Last 7 days', { exact: true })).toBeVisible();
    });

    test('TC-E08-A02: per-project rollup shows each seeded project + its cost (AC-2)', async ({ authedPage }) => {
        const usage = fleet!.usage!;
        await authedPage.goto('/activity');
        await expect(authedPage.getByText(/per project/i).first()).toBeVisible({ timeout: 30_000 });

        for (const { basename, cost } of Object.values(usage.perTag)) {
            await expect(authedPage.getByText(basename, { exact: true }).first()).toBeVisible();
            await expect(authedPage.getByText(`$${cost.toFixed(2)}`).first()).toBeVisible();
        }
    });

    test('TC-E08-A03: sessions are grouped under today\'s calendar day (AC-1)', async ({ authedPage }) => {
        const usage = fleet!.usage!;
        await authedPage.goto('/activity');
        // Wait for content (totals) before asserting the day group.
        await expect(authedPage.getByText(`$${usage.totalCost.toFixed(2)}`).first())
            .toBeVisible({ timeout: 30_000 });

        const today = localYmd(new Date());
        await expect(authedPage.getByText(today).first()).toBeVisible();
    });
});
