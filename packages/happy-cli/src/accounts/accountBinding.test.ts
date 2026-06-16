import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRandomBytes } from '@/api/encryption'
import { addAccount } from '@/accounts/accountVault'
import { applyAccountBinding, type BindingProxy } from '@/accounts/accountBinding'

const fakeProxy = () => {
  const calls: Array<{ key: string; account: string; realToken: string }> = []
  const proxy: BindingProxy = { port: 9999, register: (k, r) => { calls.push({ key: k, ...r }) } }
  return { proxy, calls }
}
const newFp = async () => join(await mkdtemp(join(tmpdir(), 'bind-')), 'v.json')
const constKey = () => 'rk-TEST'

describe('applyAccountBinding', () => {
  it('engaged via default → muteert env, registreert key, stript API-key, token niet in env (AC-2/3/7)', async () => {
    const key = getRandomBytes(32)
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'work', oauthToken: 'sk-ant-oat01-REAL' })
    const { proxy, calls } = fakeProxy()
    const extraEnv: Record<string, string> = {}
    const r = await applyAccountBinding(extraEnv, { agent: 'claude' },
      { vaultFile: fp, masterKey: key, proxy, mintKey: constKey })
    expect(r).toEqual({ ok: true, stripApiKey: true, binding: { routingKey: 'rk-TEST', account: 'work' } })
    expect(extraEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999')
    expect(extraEnv.ANTHROPIC_AUTH_TOKEN).toBe('rk-TEST')
    expect(calls).toEqual([{ key: 'rk-TEST', account: 'work', realToken: 'sk-ant-oat01-REAL' }])
    expect(JSON.stringify(extraEnv)).not.toContain('sk-ant-oat01-REAL') // alleen routing-key
  })

  it('expliciet account wint van default', async () => {
    const key = getRandomBytes(32)
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A', isDefault: true })
    await addAccount(fp, key, { provider: 'claude', name: 'b', oauthToken: 'sk-ant-oat01-B' })
    const { proxy, calls } = fakeProxy()
    await applyAccountBinding({}, { agent: 'claude', account: 'b' },
      { vaultFile: fp, masterKey: key, proxy, mintKey: constKey })
    expect(calls[0].account).toBe('b')
  })

  it('geen accounts (lege vault), geen expliciet account → passthrough, niet engaged (D-E10-13)', async () => {
    const fp = await newFp()
    const { proxy, calls } = fakeProxy()
    const extraEnv: Record<string, string> = {}
    const r = await applyAccountBinding(extraEnv, { agent: 'claude' },
      { vaultFile: fp, masterKey: getRandomBytes(32), proxy, mintKey: constKey })
    expect(r).toEqual({ ok: true, stripApiKey: false })
    expect(extraEnv.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('local preset (ANTHROPIC_BASE_URL al gezet) → skip (D-E10-3)', async () => {
    const key = getRandomBytes(32)
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    const { proxy, calls } = fakeProxy()
    const extraEnv = { ANTHROPIC_BASE_URL: 'http://localhost:11434' }
    const r = await applyAccountBinding(extraEnv, { agent: 'claude' },
      { vaultFile: fp, masterKey: key, proxy, mintKey: constKey })
    expect(r).toEqual({ ok: true, stripApiKey: false })
    expect(extraEnv.ANTHROPIC_BASE_URL).toBe('http://localhost:11434') // ongemoeid
    expect(calls).toEqual([])
  })

  it('niet-claude agent → skip', async () => {
    const { proxy, calls } = fakeProxy()
    const r = await applyAccountBinding({}, { agent: 'codex' },
      { vaultFile: await newFp(), masterKey: getRandomBytes(32), proxy, mintKey: constKey })
    expect(r.ok).toBe(true)
    expect(calls).toEqual([])
  })

  it('engaged maar resolve faalt (expliciet onbekend account) → fail-closed (AC-6)', async () => {
    const key = getRandomBytes(32)
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    const { proxy, calls } = fakeProxy()
    const r = await applyAccountBinding({}, { agent: 'claude', account: 'nope' },
      { vaultFile: fp, masterKey: key, proxy, mintKey: constKey })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/account/i)
    expect(calls).toEqual([])
  })

  it('engaged (default aanwezig) maar verkeerde sleutel → decrypt faalt → fail-closed (AC-6)', async () => {
    const key = getRandomBytes(32)
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    const { proxy } = fakeProxy()
    const r = await applyAccountBinding({}, { agent: 'claude' },
      { vaultFile: fp, masterKey: getRandomBytes(32), proxy, mintKey: constKey })
    expect(r.ok).toBe(false)
  })
})
