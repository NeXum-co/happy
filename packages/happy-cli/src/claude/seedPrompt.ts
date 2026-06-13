/**
 * Seed-prompt helper for autonomous remote sessions.
 *
 * An autonomous job spawns a daemon-side remote session with an initial prompt
 * (carried via the HAPPY_INITIAL_PROMPT env var). seedFirstMessage decides
 * whether that prompt should be injected as the first user message, so the
 * session starts working immediately instead of sitting idle waiting for app
 * input. It fires exactly once per session (gated by `alreadySeeded`).
 */

/** Returns the one-time seed prompt for an autonomous remote session, or null if none/already seeded. */
export function seedFirstMessage(envValue: string | undefined, alreadySeeded: boolean): string | null {
    if (alreadySeeded) return null;
    if (!envValue || envValue.length === 0) return null;
    return envValue;
}
