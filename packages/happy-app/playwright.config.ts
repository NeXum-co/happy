import { defineConfig, devices } from '@playwright/test';

// Committed web-E2E for the happy-app (E10 multi-subscription screens first; reusable infra).
// Serves a pre-built `expo export` web build (dist-e2e) on a dedicated port — never the live :8081.
// Auth + relay URL are injected at runtime via e2e/fixtures (no rebuild, no secrets committed).
const PORT = Number(process.env.HAPPY_E2E_PORT || 8099);

export default defineConfig({
    testDir: './e2e',
    // Sequential: the injected auth/relay state is process-global on the relay side
    // (auth-race, ds_e2e-explicit-storagestate-sequential).
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
    globalSetup: './e2e/support/globalSetup.ts',
    globalTeardown: './e2e/support/globalTeardown.ts',
    timeout: 60_000,
    expect: { timeout: 15_000 },
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        // canvaskit.wasm + heavy JS bundle: give navigation room.
        navigationTimeout: 30_000,
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        command: `node e2e/support/static-server.mjs dist-e2e ${PORT}`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
