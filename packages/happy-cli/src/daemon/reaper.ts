/**
 * Lifecycle reaper for the daemon.
 *
 * Sessions that die hard (kill -9, terminal closed, machine crash) never get
 * to deactivate themselves on the server, so they stay `active === true`
 * forever and clutter every client. The reaper walks the sessions persisted
 * on THIS machine (~/.happy/sessions.json — exactly the sessions we hold
 * encryption keys for), compares them with the server state, and archives
 * the ones whose host process is provably gone.
 *
 * Runs once at daemon start and on every heartbeat tick (see daemon/run.ts).
 */

import { execFileSync } from 'node:child_process';
import { logger } from '@/ui/logger';
import { decrypt, decodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import type { PersistedSession } from '@/persistence';
import type { SessionListItem } from '@/api/api';

/** A session heartbeats every 2s; active within this window ⇒ alive (F2 guard). */
export const REAPER_ALIVE_GRACE_MS = 30_000;
/** No heartbeat for this long ⇒ host is gone even if its (reused) PID looks alive (F1 net). */
export const REAPER_STALE_AFTER_MS = 120_000;

/**
 * Pure archive decision. Archive only a session the server still claims is
 * active AND that is provably gone. Liveness is corroborated with the session's
 * heartbeat (`activeAt`) so the PID probe alone cannot mislead us:
 *  - Fresh heartbeat (< grace) ⇒ alive, never archive — even if metadata still
 *    carries a stale, now-dead hostPid from before a resume-in-place (F2).
 *  - Known PID that is dead ⇒ archive (the fast, common path).
 *  - No heartbeat for too long (> stale) ⇒ archive even if the old PID now looks
 *    alive through OS PID reuse (F1 safety net).
 * No PID known → never guess on the PID, but a long-stale session is still gone.
 */
export function shouldArchive(
  s: { serverActive: boolean; hostPid?: number; activeAt: number },
  pidAlive: (pid: number) => boolean,
  now: number,
): boolean {
  if (!s.serverActive) return false;
  const sinceActive = now - s.activeAt;
  if (sinceActive < REAPER_ALIVE_GRACE_MS) return false; // heartbeating → alive (F2)
  if (!s.hostPid) return false; // geen pid bekend → niet gokken op de pid
  if (!pidAlive(s.hostPid)) return true; // host pid is provably gone
  return sinceActive > REAPER_STALE_AFTER_MS; // reused-pid safety net (F1)
}

/**
 * Liveness probe via signal 0. Only ESRCH means "process gone";
 * EPERM means the process exists but is owned by someone else → alive.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Best-effort wall-clock start time (epoch ms) of a live pid, used to tell a
 * still-running original process apart from a same-pid reuse (F5). Uses
 * `ps -o lstart=` which exists on Linux and macOS; on Windows (no ps) or any
 * parse failure it returns null, and callers degrade to a liveness-only check.
 * This is identity hardening, not a hard guarantee — null means "can't tell".
 */
export function pidStartTimeMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

export interface ReaperDeps {
  readPersistedSessions: () => Record<string, PersistedSession>;
  getSessions: () => Promise<SessionListItem[]>;
  deactivateSession: (sessionId: string) => Promise<boolean>;
  pidAlive?: (pid: number) => boolean;
}

/**
 * One reaper pass: persisted sessions → server state → archive dead ones.
 * Never throws — a failed pass just retries on the next heartbeat.
 */
export async function runReaperOnce(deps: ReaperDeps): Promise<void> {
  const pidAlive = deps.pidAlive ?? isPidAlive;
  try {
    const persisted = deps.readPersistedSessions();
    const sessionIds = Object.keys(persisted);
    if (sessionIds.length === 0) return;

    const serverSessions = await deps.getSessions();
    const serverById = new Map(serverSessions.map(s => [s.id, s]));

    for (const sessionId of sessionIds) {
      const server = serverById.get(sessionId);
      if (!server || !server.active) continue;

      let metadata: Metadata | null = null;
      try {
        metadata = decrypt(
          decodeBase64(persisted[sessionId].encryptionKey),
          persisted[sessionId].encryptionVariant,
          decodeBase64(server.metadata),
        ) as Metadata | null;
      } catch (error) {
        logger.debug(`[REAPER] Failed to decrypt metadata for session ${sessionId}, skipping`, error);
        continue;
      }

      if (shouldArchive({ serverActive: server.active, hostPid: metadata?.hostPid, activeAt: server.activeAt }, pidAlive, Date.now())) {
        const archived = await deps.deactivateSession(sessionId);
        if (archived) {
          logger.debug(`[REAPER] Session ${sessionId} active on server but hostPid ${metadata?.hostPid} is dead — archive succeeded`);
        } else {
          // SF-004: a failed archive keeps a dead session visible as live;
          // warn so repeated failures show up (pass reruns every heartbeat).
          logger.warn(`[REAPER] Session ${sessionId} active on server but hostPid ${metadata?.hostPid} is dead — archive failed, will retry on next heartbeat`);
        }
      }
    }
  } catch (error) {
    logger.debug('[REAPER] Reaper pass failed, will retry on next heartbeat:', error);
  }
}
