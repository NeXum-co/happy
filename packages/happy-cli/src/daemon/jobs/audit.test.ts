/**
 * Unit tests for the per-job git audit helpers.
 *
 * NO mocking — each test runs a real temp git repo created with `git init` and
 * driven through real commits via execFileSync. captureGitState reports the
 * head/branch and dirty flag; diffSince surfaces working-tree changes since a
 * captured commit; a non-git directory degrades to the empty shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureGitState, diffSince } from './audit'

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
}

function initRepo(dir: string): void {
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
}

describe('captureGitState', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-audit-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports head, branch and clean state for a committed repo', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'file.txt'), 'hello\n')
    git(dir, 'add', 'file.txt')
    git(dir, 'commit', '-m', 'initial')

    const state = captureGitState(dir)
    expect(state.head).toMatch(/^[0-9a-f]{40}$/)
    expect(state.branch).toBe('main')
    expect(state.dirty).toBe(false)
  })

  it('reports dirty when there are uncommitted changes', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'file.txt'), 'hello\n')
    git(dir, 'add', 'file.txt')
    git(dir, 'commit', '-m', 'initial')

    writeFileSync(join(dir, 'file.txt'), 'hello changed\n')

    expect(captureGitState(dir).dirty).toBe(true)
  })

  it('degrades to the empty shape for a non-git directory without throwing', () => {
    const state = captureGitState(dir)
    expect(state).toEqual({ branch: '', head: '', dirty: false })
  })
})

describe('diffSince', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-audit-diff-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('contains the changed content committed after the captured head', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'file.txt'), 'first line\n')
    git(dir, 'add', 'file.txt')
    git(dir, 'commit', '-m', 'initial')

    const before = captureGitState(dir).head

    writeFileSync(join(dir, 'file.txt'), 'first line\nSECOND_LINE_MARKER\n')
    git(dir, 'add', 'file.txt')
    git(dir, 'commit', '-m', 'change')

    const diff = diffSince(dir, before)
    expect(diff).toContain('SECOND_LINE_MARKER')
  })

  it('includes uncommitted working-tree changes since the captured head', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'file.txt'), 'first line\n')
    git(dir, 'add', 'file.txt')
    git(dir, 'commit', '-m', 'initial')

    const before = captureGitState(dir).head

    writeFileSync(join(dir, 'file.txt'), 'first line\nUNCOMMITTED_MARKER\n')

    expect(diffSince(dir, before)).toContain('UNCOMMITTED_MARKER')
  })

  it('returns an empty string on error', () => {
    expect(diffSince(dir, 'deadbeef')).toBe('')
  })
})
