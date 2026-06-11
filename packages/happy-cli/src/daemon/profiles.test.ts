/**
 * Unit tests for spawn profiles (preset spawn).
 *
 * loadProfiles reads <happy-home>/profiles.json: a valid file yields named
 * profiles with ~-expanded directories, anything broken (missing file,
 * invalid JSON, schema mismatch) yields an empty list without throwing.
 * sanitizeWindowName reduces a free-form session name to a tmux-safe
 * window name ([a-z0-9-] only).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { loadProfiles, sanitizeWindowName } from './profiles'

describe('loadProfiles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-profiles-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads a valid profiles file and expands ~ in directories', () => {
    writeFileSync(join(dir, 'profiles.json'), JSON.stringify({
      nexum: { directory: '~/code/nexum', claudeArgs: ['--dangerously-skip-permissions'], tmuxSession: 'nexum' },
      proxuma: { directory: '~/code/proxuma', claudeArgs: ['--dangerously-skip-permissions'], tmuxSession: 'proxuma' },
      dxfferent: { directory: '~/code/dxfferent', claudeArgs: ['--dangerously-skip-permissions'], tmuxSession: 'dxfferent' },
    }))

    const profiles = loadProfiles(dir)

    expect(profiles).toHaveLength(3)
    expect(profiles.map(p => p.name)).toEqual(['nexum', 'proxuma', 'dxfferent'])
    expect(profiles[0]).toEqual({
      name: 'nexum',
      directory: join(homedir(), 'code/nexum'),
      claudeArgs: ['--dangerously-skip-permissions'],
      tmuxSession: 'nexum',
    })
  })

  it('treats claudeArgs and tmuxSession as optional', () => {
    writeFileSync(join(dir, 'profiles.json'), JSON.stringify({
      bare: { directory: '/srv/projects/bare' },
    }))

    const profiles = loadProfiles(dir)

    expect(profiles).toEqual([{
      name: 'bare',
      directory: '/srv/projects/bare',
      claudeArgs: [],
      tmuxSession: undefined,
    }])
  })

  it('returns an empty list when the file is missing', () => {
    expect(loadProfiles(dir)).toEqual([])
  })

  it('returns an empty list for invalid JSON without throwing', () => {
    writeFileSync(join(dir, 'profiles.json'), '{ this is not json')

    expect(() => loadProfiles(dir)).not.toThrow()
    expect(loadProfiles(dir)).toEqual([])
  })

  it('returns an empty list for schema-invalid content without throwing', () => {
    writeFileSync(join(dir, 'profiles.json'), JSON.stringify({
      broken: { directory: 42, claudeArgs: 'not-an-array' },
    }))

    expect(() => loadProfiles(dir)).not.toThrow()
    expect(loadProfiles(dir)).toEqual([])
  })
})

describe('sanitizeWindowName', () => {
  it('lowercases and replaces disallowed characters with dashes', () => {
    expect(sanitizeWindowName('E02 Test!')).toBe('e02-test')
  })

  it('keeps already-safe names untouched', () => {
    expect(sanitizeWindowName('e02-test')).toBe('e02-test')
  })

  it('collapses runs of disallowed characters and trims edge dashes', () => {
    expect(sanitizeWindowName('  Héllo___Wörld?? ')).toBe('h-llo-w-rld')
  })

  it('returns an empty string when nothing survives', () => {
    expect(sanitizeWindowName('???')).toBe('')
  })
})
