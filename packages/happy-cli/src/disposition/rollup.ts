// src/disposition/rollup.ts
/**
 * Read-only loader for the disposition-rollup JSON (D-E05-6). The rollup is
 * Joshua-curated and generated outside this codebase; E05 only ever reads it.
 * Any read/parse/shape failure returns null so the gate fails closed (D-E05-5).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import type { DispositionRollup } from './types';

export const DEFAULT_ROLLUP_PATH = join(homedir(), '.claude', 'memory', 'personal', 'disposition-rollup.json');

export function loadRollup(path: string = DEFAULT_ROLLUP_PATH): DispositionRollup | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    logger.debug(`[E05 GATE] rollup not found at ${path} — failing closed`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DispositionRollup;
    if (typeof parsed?.generatedFrom !== 'number' || typeof parsed?.domains !== 'object' || typeof parsed?.topics !== 'object') {
      // A present-but-malformed rollup is a systemic failure: the gate now holds
      // EVERY job. Surface it at warn (console-visible) so the operator can tell
      // a fleet-wide hold from a normal per-topic 'thin' gap (SF-001).
      logger.warn('[E05 GATE] rollup JSON missing required shape — failing closed, all jobs will hold');
      return null;
    }
    return parsed;
  } catch (e) {
    logger.warn('[E05 GATE] rollup JSON parse error — failing closed, all jobs will hold:', e);
    return null;
  }
}
