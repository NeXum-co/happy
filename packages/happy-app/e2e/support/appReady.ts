import { type Page } from '@playwright/test';

// Deep-linking straight to a machine sub-screen races the screen's one-shot load() (RPC, needs the
// machine's encryption) against the app's initial sync (fetchMachines, which initializes that
// encryption). On a cold deep-link load() usually loses -> "Machine encryption not found" -> empty.
// A real user reaches these screens by navigating *within* the loaded app. We mirror that: land on
// the lighter machine-detail screen, let sync settle, then click through (client-side nav) so the
// sub-screen mounts with encryption ready. Retries the whole flow to absorb slow syncs.

const SYNC_SETTLE_MS = 4000;

/** Open the accounts screen via machine-detail click-through, waiting until `anchorText` is visible. */
export async function openAccounts(page: Page, machineId: string, anchorText = 'A', attempts = 4): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        await page.goto(`/machine/${machineId}`);
        const sub = page.getByText('Subscriptions', { exact: true });
        try {
            await sub.waitFor({ state: 'visible', timeout: 15000 });
            await page.waitForTimeout(SYNC_SETTLE_MS);
            await sub.click();
            await page.getByText(anchorText, { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
            return;
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`openAccounts: "${anchorText}" never appeared after ${attempts} attempts\n${lastErr}`);
}

/** Navigate to a path and wait for the app to be synced enough that `anchorText` renders, with retries. */
export async function gotoUntilVisible(page: Page, path: string, anchorText: string, opts: { exact?: boolean; attempts?: number; perAttemptMs?: number } = {}): Promise<void> {
    const { exact = true, attempts = 5, perAttemptMs = 8000 } = opts;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        await page.goto(path);
        await page.waitForTimeout(SYNC_SETTLE_MS);
        try {
            await page.getByText(anchorText, { exact }).first().waitFor({ state: 'visible', timeout: perAttemptMs });
            return;
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`gotoUntilVisible: "${anchorText}" never appeared at ${path} after ${attempts} attempts\n${lastErr}`);
}
