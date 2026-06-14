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
 * Decides whether an autonomous (seeded) remote session should end after its
 * single seeded turn. A normal remote session sits idle waiting for the next app
 * message; an autonomous job has no app behind it, so once it has run its one
 * seeded turn (and nothing is pending) it must return null from nextMessage so
 * the process exits with code 0 and the job can transition running -> succeeded.
 * Interactive sessions (isAutonomous false) are never affected.
 */
export function shouldExitAutonomous(isAutonomous: boolean, seeded: boolean, hasPending: boolean): boolean {
    return isAutonomous && seeded && !hasPending;
}

/**
 * Resolves the seed-time permission mode for an autonomous remote session from
 * the shared job env contract (set by the spawning phase, P6b):
 *
 * - HAPPY_JOB_PERMISSION_MODE = 'bypassPermissions' (TRUSTED) -> bypass mode.
 * - HAPPY_JOB_PERMISSION_MODE = 'default' (SUPERVISED) -> default mode, with the
 *   optional HAPPY_JOB_ALLOWED_TOOLS CSV narrowing the allowed tool set.
 * - Env absent -> normal app-driven default mode (no override).
 *
 * HAPPY_JOB_MODEL, when set, pins the model on the seed mode. Remote mode
 * otherwise defaults the model (ignoring ANTHROPIC_MODEL), so a local-preset
 * job must pin its model explicitly (e.g. 'qwen-moe') to reach llama-swap.
 */
export function resolveSeedMode(env: NodeJS.ProcessEnv): EnhancedMode {
    const permission = env.HAPPY_JOB_PERMISSION_MODE;
    const allowedTools = (env.HAPPY_JOB_ALLOWED_TOOLS ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

    const mode: EnhancedMode = {
        permissionMode: permission === 'bypassPermissions' ? 'bypassPermissions' : 'default',
    };
    if (allowedTools.length > 0) mode.allowedTools = allowedTools;
    if (env.HAPPY_JOB_MODEL) mode.model = env.HAPPY_JOB_MODEL;
    return mode;
}
