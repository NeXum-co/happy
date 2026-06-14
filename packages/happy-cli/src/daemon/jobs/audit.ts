/**
 * Per-job git audit trail (D-E04-7).
 *
 * Pure helpers over the `git` CLI that let a reviewer see exactly what an
 * autonomous job changed. captureGitState records the branch/head/dirty state
 * of a job's directory at a lifecycle moment; diffSince produces a working-tree
 * diff since a captured commit. Both DEGRADE rather than throw — a missing git
 * repo or any git error must never break a running job.
 */

import { execFileSync } from 'node:child_process'

export interface GitState {
  branch: string
  head: string
  dirty: boolean
}

export function captureGitState(dir: string): GitState {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    return { branch, head, dirty: status.trim().length > 0 }
  } catch {
    return { branch: '', head: '', dirty: false }
  }
}

// TODO(E04 review endpoint): wire diffSince — forward infra for the diff-review
// endpoint; exported + tested but not yet called from production.
export function diffSince(dir: string, beforeHead: string): string {
  try {
    return execFileSync('git', ['diff', beforeHead, '--', '.'], { cwd: dir, encoding: 'utf8' })
  } catch {
    return ''
  }
}
