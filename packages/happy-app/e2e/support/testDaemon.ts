// Isolated test daemon lifecycle for the committed web-E2E (E10 Slice B).
//
// Starts a happy daemon with its OWN HAPPY_HOME_DIR (never the live ~/.happy), seeded with DUMMY
// claude accounts, registered as a FRESH machine (randomUUID machineId) on the local relay — so the
// E10 account screens get real-but-safe RPC data. The machine shares the account (copied access.key)
// so the logged-in app sees it. Proven live 2026-06-17: fresh machineId, "registered/updated with
// server", ws connected, POST /list-accounts -> A(default)/B/C metadata-only.
//
// Process safety: the daemon is started detached (its own process group); teardown kills the group
// by pid (gotcha_broad-pkill-kills-real-daemon: never pkill by name, only the recorded pid).

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { serverUrl } from './credentials';

const HOME = homedir();
const LIVE_HAPPY = join(HOME, '.happy');
const TEST_HOME = process.env.HAPPY_E2E_HOME || join(HOME, '.happy-e10-e2e');
const CLI_DIR = join(__dirname, '..', '..', '..', 'happy-cli');        // packages/happy-cli
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');             // worktree root
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const MACHINE_FILE = join(__dirname, '..', '.auth', 'machine.json');
const PGID_FILE = join(TEST_HOME, 'e2e-daemon.pgid');

let daemon: ChildProcess | null = null;

function settingsMachineId(): string | null {
    const f = join(TEST_HOME, 'settings.json');
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')).machineId ?? null; } catch { return null; }
}

function logHas(needle: string): boolean {
    const logsDir = join(TEST_HOME, 'logs');
    if (!existsSync(logsDir)) return false;
    const logs = readdirSync(logsDir).filter((f) => f.endsWith('.log')).sort();
    const latest = logs[logs.length - 1];
    if (!latest) return false;
    try { return readFileSync(join(logsDir, latest), 'utf8').includes(needle); } catch { return false; }
}

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`testDaemon: timeout waiting for ${label}`);
}

function killRecordedGroup() {
    if (!existsSync(PGID_FILE)) return;
    try {
        const pgid = Number(readFileSync(PGID_FILE, 'utf8').trim());
        if (pgid > 0) { try { process.kill(-pgid, 'SIGTERM'); } catch {} }
    } catch {}
}

export async function startTestDaemon(): Promise<{ machineId: string }> {
    if (!existsSync(join(LIVE_HAPPY, 'access.key'))) {
        throw new Error('testDaemon: no ~/.happy/access.key to copy (need a logged-in account)');
    }
    // Kill any stale test daemon from a previous run, then a clean isolated home.
    killRecordedGroup();
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    copyFileSync(join(LIVE_HAPPY, 'access.key'), join(TEST_HOME, 'access.key'));

    const env = { ...process.env, HAPPY_HOME_DIR: TEST_HOME, HAPPY_SERVER_URL: serverUrl() };

    // Seed the vault with dummy accounts + burn-policy (no real token).
    const seed = spawnSync(TSX, ['scripts/e2eSeedVault.ts'], { cwd: CLI_DIR, env, encoding: 'utf8' });
    if (seed.status !== 0) {
        throw new Error(`testDaemon: vault seed failed: ${seed.stderr || seed.stdout}`);
    }

    // Start the daemon detached (own process group) so teardown can kill the whole tsx tree.
    daemon = spawn(TSX, ['src/index.ts', 'daemon', 'start-sync'], {
        cwd: CLI_DIR, env, detached: true, stdio: 'ignore',
    });
    daemon.unref();
    if (daemon.pid) writeFileSync(PGID_FILE, String(daemon.pid), 'utf8');

    await waitFor(() => !!settingsMachineId() && existsSync(join(TEST_HOME, 'daemon.state.json')),
        40_000, 'machineId + daemon.state.json');
    await waitFor(() => logHas('registered/updated with server'), 40_000, 'relay registration');

    const machineId = settingsMachineId()!;
    mkdirSync(dirname(MACHINE_FILE), { recursive: true });
    writeFileSync(MACHINE_FILE, JSON.stringify({ machineId }), 'utf8');
    return { machineId };
}

export async function stopTestDaemon(): Promise<void> {
    if (daemon?.pid) { try { process.kill(-daemon.pid, 'SIGTERM'); } catch {} }
    killRecordedGroup();
    daemon = null;
    try { if (existsSync(MACHINE_FILE)) rmSync(MACHINE_FILE); } catch {}
}
