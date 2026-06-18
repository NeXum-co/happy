/**
 * TC-B09 — autonomous job-account binding, INTEGRATION MIRROR.
 *
 * The scheduler.test.ts sibling proves only the first link (runJob copies
 * job.account onto SpawnSessionOptions.account). This suite proves the WHOLE
 * autonomous spine: a submitted job with account:'B' flows
 *   buildJobFromSubmit → JobStore → scheduler.tick() → runJob →
 *   SpawnSessionOptions.account → applyAccountBinding (real vault) → proxy bound to B.
 *
 * Isolation (like gateScenarios/cronIntegration): a REAL tmp JobStore + REAL
 * JobScheduler + REAL applyAccountBinding against a REAL tmp accounts-vault. The
 * only injected piece is the `spawn` closure — it is an EXECUTABLE MIRROR of the
 * spawnSession chokepoint in run.ts (D-E10-14): it runs the same
 * applyAccountBinding(extraEnv, {agent, account}, deps) call over a fake proxy
 * (records registrations, never opens a socket) and returns success/error the way
 * spawnSession does. No relay, no auth, no network, no real daemon — runs under
 * the `unit` vitest project so it never rebuilds dist/ or disturbs the live daemon.
 *
 * preset:'cloud-x' keeps isLocal=false so the spawn is a cloud-Claude spawn (a
 * local preset would set ANTHROPIC_BASE_URL and binding would skip, D-E10-3 —
 * covered in accountBinding.test.ts). gateResolved short-circuits the E05 gate so
 * this exercises the account dimension, not the disposition gate (covered in
 * gateScenarios.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from './jobStore'
import { Semaphore } from './semaphore'
import { JobScheduler, buildJobFromSubmit } from './scheduler'
import { getRandomBytes } from '@/api/encryption'
import { addAccount } from '@/accounts/accountVault'
import { applyAccountBinding, type BindingProxy } from '@/accounts/accountBinding'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers'

describe('TC-B09 — autonomous job-account binding (integration mirror)', () => {
  let dir: string
  let store: JobStore
  let vaultFile: string
  const masterKey = getRandomBytes(32)

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'happy-b09-'))
    store = new JobStore(join(dir, 'jobs.db'))
    store.init()
    // Seed the same A(default)/B/C shape the e2e seeder uses; each token is distinct
    // so the proxy registration unambiguously identifies which account was resolved.
    vaultFile = join(dir, 'accounts.vault.json')
    await addAccount(vaultFile, masterKey, { provider: 'claude', name: 'A', oauthToken: 'sk-ant-oat01-A', isDefault: true })
    await addAccount(vaultFile, masterKey, { provider: 'claude', name: 'B', oauthToken: 'sk-ant-oat01-B' })
    await addAccount(vaultFile, masterKey, { provider: 'claude', name: 'C', oauthToken: 'sk-ant-oat01-C' })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // A fake proxy that records every key→{account,realToken} registration (no socket).
  function fakeProxy() {
    const calls: Array<{ key: string; account: string; realToken: string }> = []
    const proxy: BindingProxy = { port: 9999, register: (k, r) => { calls.push({ key: k, ...r }) } }
    return { proxy, calls }
  }

  // The spawnSession chokepoint (run.ts D-E10-14), as an injectable spawn: bind the
  // cloud-spawn to an account via the real applyAccountBinding, then return the
  // success/error the daemon returns. Records the bound result for assertions.
  function bindingSpawn(proxy: BindingProxy) {
    const seen: { opts?: SpawnSessionOptions; binding?: { routingKey: string; account: string }; error?: string } = {}
    const spawn = async (opts: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      seen.opts = opts
      const extraEnv = { ...(opts.environmentVariables ?? {}) }
      const r = await applyAccountBinding(extraEnv, { agent: 'claude', account: opts.account },
        { vaultFile, masterKey, proxy })
      if (!r.ok) {
        seen.error = r.error
        return { type: 'error', errorMessage: r.error }
      }
      seen.binding = r.binding
      seen.opts = { ...opts, environmentVariables: extraEnv } // env after binding mutation
      return { type: 'success', sessionId: 'sess-b09' }
    }
    return { spawn, seen }
  }

  function scheduler(spawn: (o: SpawnSessionOptions) => Promise<SpawnSessionResult>) {
    return new JobScheduler({ store, localSemaphore: new Semaphore(1), spawn })
  }

  it('TC-B09: a submitted job with account:"B" binds the autonomous spawn to B (not the default A)', async () => {
    const job = buildJobFromSubmit({ directory: dir, prompt: '[B09] autonomous work', preset: 'cloud-x', account: 'B' }, 1000, 'b09')
    store.create({ ...job, gateResolved: true }) // already-approved; isolate the account dimension from the E05 gate
    const { proxy, calls } = fakeProxy()
    const { spawn, seen } = bindingSpawn(proxy)

    await scheduler(spawn).tick()

    // The account survived the whole spine: submit params → JobRecord → SpawnSessionOptions.
    expect(seen.opts?.account).toBe('B')
    // applyAccountBinding resolved B from the vault and registered ITS token (not A's).
    expect(seen.binding?.account).toBe('B')
    expect(calls).toHaveLength(1)
    expect(calls[0].account).toBe('B')
    expect(calls[0].realToken).toBe('sk-ant-oat01-B')
    // AC-7: the session env carries only the routing-key, never the real token.
    const env = seen.opts!.environmentVariables!
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(calls[0].key)
    expect(JSON.stringify(env)).not.toContain('sk-ant-oat01-B')
    // The job is now running under account B.
    expect(store.get('b09')!.status).toBe('running')
  })

  it('TC-B09b: a submitted job with NO account engages the default (binds to A) on the autonomous path', async () => {
    const job = buildJobFromSubmit({ directory: dir, prompt: '[B09] no explicit account', preset: 'cloud-x' }, 1000, 'b09b')
    store.create({ ...job, gateResolved: true })
    const { proxy, calls } = fakeProxy()
    const { spawn, seen } = bindingSpawn(proxy)

    await scheduler(spawn).tick()

    expect(seen.opts?.account).toBeUndefined() // no explicit account on the job
    expect(seen.binding?.account).toBe('A') // default-account engaged (D-E10-13)
    expect(calls[0].realToken).toBe('sk-ant-oat01-A')
    expect(store.get('b09b')!.status).toBe('running')
  })

  it('TC-B09c: a submitted job with an unknown account fails closed — the autonomous spawn is refused, nothing bound (AC-6)', async () => {
    const job = buildJobFromSubmit({ directory: dir, prompt: '[B09] ghost account', preset: 'cloud-x', account: 'ghost' }, 1000, 'b09c')
    store.create({ ...job, gateResolved: true })
    const { proxy, calls } = fakeProxy()
    const { spawn, seen } = bindingSpawn(proxy)

    await scheduler(spawn).tick()

    expect(seen.error).toMatch(/account/i) // applyAccountBinding refused (fail-closed)
    expect(calls).toEqual([]) // nothing registered in the proxy — never bound to a wrong account
    expect(store.get('b09c')!.status).not.toBe('running') // the spawn was refused
  })
})
