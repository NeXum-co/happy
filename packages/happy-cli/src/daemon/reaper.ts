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

import { logger } from '@/ui/logger';
import { decrypt, decodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import type { PersistedSession } from '@/persistence';
import type { SessionListItem } from '@/api/api';

/**
 * Pure archive decision: only archive when the server still claims the
 * session is active AND we know its host PID AND that PID is dead.
 * No PID known → never guess.
 */
export function shouldArchive(s: { serverActive: boolean; hostPid?: number }, pidAlive: (pid: number) => boolean): boolean {
  if (!s.serverActive) return false;
  if (!s.hostPid) return false; // geen pid bekend → niet gokken
  return !pidAlive(s.hostPid);
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

      if (shouldArchive({ serverActive: server.active, hostPid: metadata?.hostPid }, pidAlive)) {
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
