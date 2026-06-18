import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface AppCredentials {
    token: string;
    secret: string;
}

const CRED_FILE = join(__dirname, '..', '.auth', 'credentials.json');
const MACHINE_FILE = join(__dirname, '..', '.auth', 'machine.json');
const RELAY_FILE = join(__dirname, '..', '.auth', 'relay.json');

/**
 * Load a real app auth credential ({token, secret}) for the committed E2E suite.
 * Source of truth: gitignored e2e/.auth/credentials.json, or HAPPY_E2E_TOKEN/HAPPY_E2E_SECRET env.
 * The credential must originate from a real logged-in app session (see e2e/README.md) — the daemon's
 * access.key (dataKey variant) is NOT directly usable. Returns null when absent (-> graceful skip).
 */
export function loadCredentials(): AppCredentials | null {
    const envToken = process.env.HAPPY_E2E_TOKEN;
    const envSecret = process.env.HAPPY_E2E_SECRET;
    if (envToken && envSecret) return { token: envToken, secret: envSecret };

    if (existsSync(CRED_FILE)) {
        try {
            const raw = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
            if (raw && typeof raw.token === 'string' && typeof raw.secret === 'string') {
                return { token: raw.token, secret: raw.secret };
            }
        } catch {
            // fall through to null — never throw a parsed secret into the log
        }
    }
    return null;
}

/**
 * Relay base URL the app + test daemon should talk to. Source of truth is the isolated relay URL
 * written by globalSetup (.auth/relay.json), so the whole suite is self-contained. Falls back to env,
 * then the live local relay (legacy).
 */
export function serverUrl(): string {
    if (process.env.EXPO_PUBLIC_HAPPY_SERVER_URL) return process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    if (existsSync(RELAY_FILE)) {
        try {
            const raw = JSON.parse(readFileSync(RELAY_FILE, 'utf8'));
            if (raw && typeof raw.url === 'string') return raw.url;
        } catch {}
    }
    return 'http://localhost:3005';
}

const FLEET_FILE = join(__dirname, '..', '.auth', 'fleet.json');

export interface SeededFleetFile {
    homeDir: string;
    sessions: { tag: string; project: string; id: string; archived: boolean }[];
    needsYouRemoteTag: string;
    localAttentionTag: string;
    idleTag: string;
    archivedTags: string[];
    projects: string[];
    /** Seeded UsageReport expectations (E08 activity-dashboard specs). */
    usage?: {
        perTag: Record<string, { tokens: number; cost: number; basename: string }>;
        totalTokens: number;
        totalCost: number;
    };
}

/** The seeded fleet shape written by globalSetup (seedSessions). Null when setup did not run. */
export function loadFleet(): SeededFleetFile | null {
    if (existsSync(FLEET_FILE)) {
        try {
            return JSON.parse(readFileSync(FLEET_FILE, 'utf8')) as SeededFleetFile;
        } catch {}
    }
    return null;
}

/** The isolated test daemon's machineId, written by globalSetup. Null until Slice B runs. */
export function testMachineId(): string | null {
    if (process.env.HAPPY_E2E_MACHINE_ID) return process.env.HAPPY_E2E_MACHINE_ID;
    if (existsSync(MACHINE_FILE)) {
        try {
            const raw = JSON.parse(readFileSync(MACHINE_FILE, 'utf8'));
            if (raw && typeof raw.machineId === 'string') return raw.machineId;
        } catch {}
    }
    return null;
}
