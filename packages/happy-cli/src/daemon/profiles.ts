/**
 * Spawn profiles for preset spawn (E02-C).
 *
 * A profile is a named spawn preset stored in `<happy-home>/profiles.json`:
 *
 *   { "nexum": { "directory": "~/code/nexum",
 *                "claudeArgs": ["--dangerously-skip-permissions"],
 *                "tmuxSession": "nexum" } }
 *
 * The daemon resolves a `profile` passed in spawn-happy-session options to a
 * working directory (~-expanded), extra claude args, and a tmux session name.
 * A broken file (missing, invalid JSON, schema mismatch) never crashes the
 * daemon: it logs a warning and behaves as if no profiles exist.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'

const ProfileSchema = z.object({
  directory: z.string().min(1),
  claudeArgs: z.array(z.string()).optional(),
  tmuxSession: z.string().optional(),
})

const ProfilesFileSchema = z.record(z.string(), ProfileSchema)

export interface SessionProfile {
  name: string
  /** Working directory with ~ already expanded to the user's home. */
  directory: string
  claudeArgs: string[]
  tmuxSession?: string
}

function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Load and validate `<happyHomeDir>/profiles.json`.
 * Returns an empty list (with a logged warning) on any failure — never throws.
 */
export function loadProfiles(happyHomeDir: string = configuration.happyHomeDir): SessionProfile[] {
  const file = join(happyHomeDir, 'profiles.json')
  if (!existsSync(file)) {
    return []
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    logger.warn(`[PROFILES] Ignoring ${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    return []
  }

  const parsed = ProfilesFileSchema.safeParse(raw)
  if (!parsed.success) {
    logger.warn(`[PROFILES] Ignoring ${file}: schema validation failed (${parsed.error.message})`)
    return []
  }

  return Object.entries(parsed.data).map(([name, profile]) => ({
    name,
    directory: expandTilde(profile.directory),
    claudeArgs: profile.claudeArgs ?? [],
    tmuxSession: profile.tmuxSession,
  }))
}

/**
 * Reduce a free-form session name to a tmux-safe window name:
 * lowercase, runs of anything outside [a-z0-9-] become a single dash,
 * edge dashes stripped. May return '' when nothing survives.
 */
export function sanitizeWindowName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}
