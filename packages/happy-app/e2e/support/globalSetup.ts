import type { FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startIsolatedRelay } from './isolatedRelay';
import { seedAccount } from './seedAccount';
import { seedSessions } from './seedSessions';
import { startTestDaemon } from './testDaemon';

// Self-contained web-E2E setup (E10 Slice C). Boots an ISOLATED happy-server (PGlite, port 3099,
// throwaway DATA_DIR — never the live relay :3005), mints a synthetic headless account, registers an
// isolated test daemon (own HAPPY_HOME_DIR, seeded dummy-account vault) so the E10 account screens get
// real-but-safe RPC data, then seeds a deterministic fleet of sessions so the rich fleet specs can
// assert the layout precisely. No live-relay dependency, no real credential — fully deterministic.

const AUTH_DIR = join(__dirname, '..', '.auth');
const RELAY_FILE = join(AUTH_DIR, 'relay.json');
const CRED_FILE = join(AUTH_DIR, 'credentials.json');
const FLEET_FILE = join(AUTH_DIR, 'fleet.json');

async function globalSetup(_config: FullConfig) {
    mkdirSync(AUTH_DIR, { recursive: true });

    // 1. Isolated relay -> publish its URL so serverUrl() (app + daemon + seeders) targets it.
    const { url } = await startIsolatedRelay();
    writeFileSync(RELAY_FILE, JSON.stringify({ url }), 'utf8');

    // 2. Synthetic account -> the credential the app injects (localStorage) and the daemon's access.key.
    const account = await seedAccount(url);
    writeFileSync(CRED_FILE, JSON.stringify({ token: account.token, secret: account.secret }), { mode: 0o600 });

    // 3. Isolated test daemon (reads serverUrl() + credentials.json, seeds its own vault, registers a
    //    fresh machine on the isolated relay). Powers the E10 account/machine screens.
    await startTestDaemon();

    // 4. Deterministic fleet of sessions for the rich fleet specs.
    const fleet = await seedSessions(url, account.token, account.masterSecret);
    writeFileSync(FLEET_FILE, JSON.stringify(fleet), 'utf8');
}

export default globalSetup;
