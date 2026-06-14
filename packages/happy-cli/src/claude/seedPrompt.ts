/**
 * Seed-prompt helper for autonomous remote sessions.
 *
 * An autonomous job spawns a daemon-side remote session with an initial prompt
 * (carried via the HAPPY_INITIAL_PROMPT env var). seedFirstMessage decides
 * whether that prompt should be injected as the first user message, so the
 * session starts working immediately instead of sitting idle waiting for app
 * input. It fires exactly once per session (gated by `alreadySeeded`).
 */

import type { EnhancedMode } from './loop';

/** Returns the one-time seed prompt for an autonomous remote session, or null if none/already seeded. */
export function seedFirstMessage(envValue: string | undefined, alreadySeeded: boolean): string | null {
    if (alreadySeeded) return null;
    if (!envValue || envValue.length === 0) return null;
    return envValue;
}

/**
 * Resolves the seed-time permission mode for an autonomous remote session from
 * the shared job env contract (set by the spawning phase, P6b):
 *
 * - HAPPY_JOB_PERMISSION_MODE = 'bypassPermissions' (TRUSTED) -> bypass mode.
 * - HAPPY_JOB_PERMISSION_MODE = 'default' (SUPERVISED) -> default mode, with the
 *   optional HAPPY_JOB_ALLOWED_TOOLS CSV narrowing the allowed tool set.
 * - Env absent -> normal app-driven default mode (no override).
 */
export function resolveSeedMode(env: NodeJS.ProcessEnv): EnhancedMode {
    const permission = env.HAPPY_JOB_PERMISSION_MODE;
    const allowedTools = (env.HAPPY_JOB_ALLOWED_TOOLS ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

    if (permission === 'bypassPermissions') {
        return allowedTools.length > 0
            ? { permissionMode: 'bypassPermissions', allowedTools }
            : { permissionMode: 'bypassPermissions' };
    }

    return allowedTools.length > 0
        ? { permissionMode: 'default', allowedTools }
        : { permissionMode: 'default' };
}
