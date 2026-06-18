/**
 * Identity-checked kill-target resolution for autonomous-job sessions.
 *
 * A deferred SIGKILL must never trust a bare pid captured 5s earlier: the OS may
 * have reused that pid for an unrelated process (the "broad pkill killed the
 * real daemon" class of incident). This pure helper re-resolves the pid by
 * sessionId against the LIVE tracking map at fire time and returns it only if
 * that exact sessionId still maps to it. A gone session, or a pid now owned by a
 * different session, yields `undefined` → the caller skips the kill.
 */

/**
 * Resolve the pid to kill for `sessionId` against the current session map.
 *
 * Returns the pid iff `sessionId` still maps to it:
 * - a normal sessionId matches a tracked entry whose `happySessionId` equals it;
 * - the `PID-<n>` synthetic form matches iff pid `<n>` is currently tracked.
 * Otherwise returns `undefined` (session gone or pid reused by another session).
 */
export function resolveKillTarget(
  sessionId: string,
  sessions: ReadonlyMap<number, { happySessionId?: string }>,
): number | undefined {
  if (sessionId.startsWith('PID-')) {
    const pid = parseInt(sessionId.slice('PID-'.length), 10);
    return sessions.has(pid) ? pid : undefined;
  }
  for (const [pid, session] of sessions) {
    if (session.happySessionId === sessionId) {
      return pid;
    }
  }
  return undefined;
}
