// Isolated happy-server relay for the committed web-E2E (E10 Slice C).
//
// Boots a fully self-contained happy-server on a PGlite backend in a throwaway DATA_DIR, on a
// DEDICATED port (3099) — NEVER the live relay :3005 and never the live daemon/vault ~/.happy. This
// lets the suite seed a synthetic account + sessions without polluting Joshua's real fleet.
//
// Process safety: migrations run blocking (own short-lived process); the serve process is started
// detached (own process group) and teardown kills the recorded process group by pid — never pkill by
// name (gotcha_broad-pkill-kills-real-daemon). The DATA_DIR is removed on teardown.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const SERVER_DIR = join(__dirname, '..', '..', '..', 'happy-server');        // packages/happy-server
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');                   // worktree root
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const STANDALONE = join(SERVER_DIR, 'sources', 'standalone.ts');

export const RELAY_PORT = Number(process.env.HAPPY_E2E_RELAY_PORT || 3099);
const RELAY_URL = `http://localhost:${RELAY_PORT}`;
const DATA_DIR = process.env.HAPPY_E2E_RELAY_DATA_DIR || join(tmpdir(), `happy-e2e-relay-${randomBytes(6).toString('hex')}`);
const PGID_FILE = join(DATA_DIR, 'relay.pgid');

let relay: ChildProcess | null = null;

function relayEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        PGLITE_DIR: join(DATA_DIR, 'pg'),
        DATA_DIR,
        HANDY_MASTER_SECRET: 'e2e-test-master-secret',
        PORT: String(RELAY_PORT),
        HOST: '127.0.0.1',
        NODE_ENV: 'development',
        DB_PROVIDER: 'pglite',
    };
}

async function httpOk(url: string): Promise<boolean> {
    try {
        const res = await fetch(url);
        return res.ok;
    } catch {
        return false;
    }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await httpOk(url)) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`isolatedRelay: ${url} did not return 200 within ${timeoutMs}ms`);
}

function killRecordedGroup() {
    if (!existsSync(PGID_FILE)) return;
    try {
        const pgid = Number(readFileSync(PGID_FILE, 'utf8').trim());
        if (pgid > 0) { try { process.kill(-pgid, 'SIGTERM'); } catch {} }
    } catch {}
}

/** Boot the isolated relay (migrate, then serve) and return its base URL once it answers HTTP 200. */
export async function startIsolatedRelay(): Promise<{ url: string; dataDir: string }> {
    // Guard the hard constraint: never collide with the live relay port.
    if (RELAY_PORT === 3005) throw new Error('isolatedRelay: refusing to use the live relay port 3005');
    // Clean any stale group from a previous crashed run, then a fresh data dir.
    killRecordedGroup();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });

    const env = relayEnv();

    // 1. Migrations (blocking, own short-lived process). Applies all migrations and exits 0.
    const migrate = spawnSync(TSX, [STANDALONE, 'migrate'], { cwd: SERVER_DIR, env, encoding: 'utf8' });
    if (migrate.status !== 0) {
        throw new Error(`isolatedRelay: migrate failed (status ${migrate.status})\n${migrate.stderr || migrate.stdout}`);
    }

    // 2. Serve (detached, own process group) so teardown can kill the whole tsx tree by pgid.
    const proc = spawn(TSX, [STANDALONE, 'serve'], { cwd: SERVER_DIR, env, detached: true, stdio: 'ignore' });
    relay = proc;
    proc.unref();
    if (proc.pid) writeFileSync(PGID_FILE, String(proc.pid), 'utf8');

    await waitForHttp(`${RELAY_URL}/`, 40_000);
    return { url: RELAY_URL, dataDir: DATA_DIR };
}

export async function stopIsolatedRelay(): Promise<void> {
    if (relay?.pid) { try { process.kill(-relay.pid, 'SIGTERM'); } catch {} }
    killRecordedGroup();
    relay = null;
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}
