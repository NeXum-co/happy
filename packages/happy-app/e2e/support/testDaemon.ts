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
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { serverUrl, loadCredentials } from './credentials';

const HOME = homedir();
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

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await pred()) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`testDaemon: timeout waiting for ${label}`);
}

// The app gates account RPCs on machine.active (isMachineOnline). The relay flips active a few
// seconds AFTER the daemon's socket connects, so we must wait for it BEFORE tests boot the app —
// otherwise the app's initial sync sees the machine offline and skips list-accounts.
async function relayReportsActive(machineId: string): Promise<boolean> {
    try {
        const cred = loadCredentials();
        if (!cred) return false;
        const res = await fetch(`${serverUrl()}/v1/machines`, { headers: { authorization: `Bearer ${cred.token}` } });
        if (!res.ok) return false;
        const data = await res.json() as any;
        const arr = Array.isArray(data) ? data : (data.machines ?? []);
        return !!arr.find((m: any) => m.id === machineId)?.active;
    } catch {
        return false;
    }
}

function killRecordedGroup() {
    if (!existsSync(PGID_FILE)) return;
    try {
        const pgid = Number(readFileSync(PGID_FILE, 'utf8').trim());
        if (pgid > 0) { try { process.kill(-pgid, 'SIGTERM'); } catch {} }
    } catch {}
}

export async function startTestDaemon(): Promise<{ machineId: string }> {
    // Build a LEGACY-format access.key from the app credential {token, secret}. This makes the test
    // daemon use the same masterSecret as the app, so both sides use legacy(masterSecret) for machine
    // encryption/RPC — avoiding the dataKey mismatch that copying ~/.happy/access.key (dataKey variant)
    // caused (app couldn't decrypt the machine's per-machine dataEncryptionKey -> "Machine encryption
    // not found" -> account RPCs threw).
    const cred = loadCredentials();
    if (!cred) throw new Error('testDaemon: no app credential (e2e/.auth/credentials.json) to build access.key');
    // Kill any stale test daemon from a previous run, then a clean isolated home.
    killRecordedGroup();
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    // The app stores the secret as unpadded base64URL (-_); the CLI credential schema requires padded
    // standard base64 (z.string().base64(): +/ and = padding). Convert the alphabet and pad — the
    // decoded 32 bytes are identical, so the masterSecret still matches the app's.
    const std = cred.secret.replace(/-/g, '+').replace(/_/g, '/');
    const stdSecret = std.padEnd(Math.ceil(std.length / 4) * 4, '=');
    writeFileSync(join(TEST_HOME, 'access.key'), JSON.stringify({ token: cred.token, secret: stdSecret }), { mode: 0o600 });

    const env = { ...process.env, HAPPY_HOME_DIR: TEST_HOME, HAPPY_SERVER_URL: serverUrl() };

    // Seed the vault with dummy accounts + burn-policy (no real token).
    const seed = spawnSync(TSX, ['scripts/e2eSeedVault.ts'], { cwd: CLI_DIR, env, encoding: 'utf8' });
    if (seed.status !== 0) {
        throw new Error(`testDaemon: vault seed failed: ${seed.stderr || seed.stdout}`);
    }

    // Seed the jobStore with deterministic E04/E05 records (runs/crons/event-subscriptions screens).
    // No 'pending' jobs ⇒ the scheduler never claims/spawns them; the cron uses a far-future expr.
    const seedJobs = spawnSync(TSX, ['scripts/seedJobs.ts'], { cwd: CLI_DIR, env, encoding: 'utf8' });
    if (seedJobs.status !== 0) {
        throw new Error(`testDaemon: job seed failed: ${seedJobs.stderr || seedJobs.stdout}`);
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
    // Wait until the relay marks the machine active, so the app boots seeing it online.
    await waitFor(() => relayReportsActive(machineId), 40_000, 'relay machine.active=true');
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
