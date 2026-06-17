import type { FullConfig } from '@playwright/test';
import { loadCredentials } from './credentials';
import { startTestDaemon } from './testDaemon';

// Boots an isolated test daemon (own HAPPY_HOME_DIR, seeded dummy-account vault) against the local
// relay, so the E10 account screens get real (but safe) RPC data. Skipped when no credential is
// present — the suite then only runs credential-free smoke (boot.spec.ts).
async function globalSetup(_config: FullConfig) {
    const creds = loadCredentials();
    if (!creds) {
        console.log('[e2e] no credential -> skipping test-daemon setup (credential-free smoke only)');
        return;
    }
    await startTestDaemon();
}

export default globalSetup;
