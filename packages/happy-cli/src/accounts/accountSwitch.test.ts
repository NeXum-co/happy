import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRandomBytes } from '@/api/encryption'
import { addAccount } from '@/accounts/accountVault'
import { applyAccountSwitch, type SwitchProxy } from '@/accounts/accountSwitch'

const fakeProxy = () => {
  const calls: Array<{ key: string; account: string; realToken: string }> = []
  const proxy: SwitchProxy = { remap: (k, r) => { calls.push({ key: k, ...r }) } }
  return { proxy, calls }
}
const newFp = async () => join(await mkdtemp(join(tmpdir(), 'switch-')), 'v.json')

// sessie→routing-key map als fake lookup (mimic findTrackedSessionById?.routingKey)
const lookup = (m: Record<string, string>) => (sid: string) => m[sid]

describe('applyAccountSwitch', () => {
  it('TC-1 happy (AC-4): remapt elke gebonden sessie naar het doel-account-token', async () => {
    const key = getRandomBytes(32)
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A', isDefault: true })
    await addAccount(fp, key, { provider: 'claude', name: 'b', oauthToken: 'sk-ant-oat01-B' })
    const { proxy, calls } = fakeProxy()
    const r = await applyAccountSwitch(['s1', 's2'], { account: 'b' },
      { vaultFile: fp, masterKey: key, proxy, lookupRoutingKey: lookup({ s1: 'rk-1', s2: 'rk-2' }) })
    expect(r).toEqual({ ok: true, remapped: ['s1', 's2'], skipped: [] })
    expect(calls).toEqual([
      { key: 'rk-1', account: 'b', realToken: 'sk-ant-oat01-B' },
      { key: 'rk-2', account: 'b', realToken: 'sk-ant-oat01-B' },
    ])
  })

  it('TC-2 gedeeltelijk: ongebonden sessie → skipped, rest geremapt', async () => {
    const key = getRandomBytes(32)
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    const { proxy, calls } = fakeProxy()
    const r = await applyAccountSwitch(['s1', 's2'], { account: 'a' },
      { vaultFile: fp, masterKey: key, proxy, lookupRoutingKey: lookup({ s1: 'rk-1' }) })
    expect(r).toEqual({ ok: true, remapped: ['s1'], skipped: ['s2'] })
    expect(calls).toEqual([{ key: 'rk-1', account: 'a', realToken: 'sk-ant-oat01-A' }])
  })

  it('TC-3 fail-closed (AC-6): doel-account niet ontsleutelbaar → geen enkele remap', async () => {
    const key = getRandomBytes(32)
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    const { proxy, calls } = fakeProxy()
    const r = await applyAccountSwitch(['s1'], { account: 'nope' },
      { vaultFile: fp, masterKey: key, proxy, lookupRoutingKey: lookup({ s1: 'rk-1' }) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/account/i)
    expect(calls).toEqual([]) // nul remaps
  })

  it('TC-4 lege selectie: ok, lege arrays, geen remap', async () => {
    const key = getRandomBytes(32)
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    const { proxy, calls } = fakeProxy()
    const r = await applyAccountSwitch([], { account: 'a' },
      { vaultFile: fp, masterKey: key, proxy, lookupRoutingKey: lookup({}) })
    expect(r).toEqual({ ok: true, remapped: [], skipped: [] })
    expect(calls).toEqual([])
  })
})
