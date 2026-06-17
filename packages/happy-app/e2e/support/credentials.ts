import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface AppCredentials {
    token: string;
    secret: string;
}

const CRED_FILE = join(__dirname, '..', '.auth', 'credentials.json');
const MACHINE_FILE = join(__dirname, '..', '.auth', 'machine.json');

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

/** Relay base URL the app should talk to (defaults to the local relay). */
export function serverUrl(): string {
    return process.env.EXPO_PUBLIC_HAPPY_SERVER_URL || 'http://localhost:3005';
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
