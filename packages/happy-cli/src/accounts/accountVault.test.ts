import { describe, it, expect } from 'vitest'
import { vaultMasterKey, loadVault, saveVault, addAccount, listAccounts, removeAccount, setDefaultAccount, resolveAccount } from '@/accounts/accountVault'
import type { Credentials } from '@/persistence'
import { getRandomBytes } from '@/api/encryption'
import { mkdtemp, readFile as rf, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('vaultMasterKey', () => {
  it('leidt een 32-byte sleutel af, deterministisch per credential', async () => {
    const creds: Credentials = { token: 't', encryption: { type: 'legacy', secret: getRandomBytes(32) } }
    const k1 = await vaultMasterKey(creds)
    const k2 = await vaultMasterKey(creds)
    expect(k1).toHaveLength(32)
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(true)
  })

  it('verschilt per master-secret', async () => {
    const a: Credentials = { token: 't', encryption: { type: 'legacy', secret: getRandomBytes(32) } }
    const b: Credentials = { token: 't', encryption: { type: 'legacy', secret: getRandomBytes(32) } }
    expect(Buffer.from(await vaultMasterKey(a)).equals(Buffer.from(await vaultMasterKey(b)))).toBe(false)
  })
})

describe('loadVault/saveVault', () => {
  it('lege/ontbrekende file → leeg vault', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-'))
    const v = await loadVault(join(dir, 'accounts.vault.json'))
    expect(v).toEqual({ version: 1, providers: {} })
  })

  it('roundtrip via atomic write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-'))
    const fp = join(dir, 'accounts.vault.json')
    await saveVault(fp, { version: 1, providers: { claude: { defaultAccount: 'a', accounts: {} } } })
    const v = await loadVault(fp)
    expect(v.providers.claude.defaultAccount).toBe('a')
    expect(JSON.parse(await rf(fp, 'utf8')).version).toBe(1)
  })

  it('corrupte file → fail-closed (throws)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-'))
    const fp = join(dir, 'accounts.vault.json')
    await writeFile(fp, '{ niet-geldig')
    await expect(loadVault(fp)).rejects.toThrow()
  })
})

describe('CRUD', () => {
  const key = getRandomBytes(32)
  const newFp = async () => join(await mkdtemp(join(tmpdir(), 'vault-')), 'v.json')

  it('add → list toont metadata, token niet plaintext in bestand (AC-1/AC-7)', async () => {
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'work', oauthToken: 'sk-ant-oat01-SECRET', isDefault: true })
    const list = await listAccounts(fp, 'claude')
    expect(list.map(a => a.name)).toEqual(['work'])
    expect(list[0].isDefault).toBe(true)
    const onDisk = await rf(fp, 'utf8')
    expect(onDisk).not.toContain('sk-ant-oat01-SECRET') // versleuteld
  })

  it('eerste account wordt automatisch default', async () => {
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    expect((await listAccounts(fp, 'claude'))[0].isDefault).toBe(true)
  })

  it('setDefault wisselt de default; remove ruimt op', async () => {
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    await addAccount(fp, key, { provider: 'claude', name: 'b', oauthToken: 'sk-ant-oat01-B' })
    await setDefaultAccount(fp, 'claude', 'b')
    expect((await listAccounts(fp, 'claude')).find(a => a.isDefault)?.name).toBe('b')
    await removeAccount(fp, 'claude', 'a')
    expect((await listAccounts(fp, 'claude')).map(a => a.name)).toEqual(['b'])
  })
})

describe('resolveAccount', () => {
  const key = getRandomBytes(32)
  const newFp = async () => join(await mkdtemp(join(tmpdir(), 'vault-')), 'v.json')

  it('expliciete naam → dat account, token decrypt roundtrip (AC-1)', async () => {
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'work', oauthToken: 'sk-ant-oat01-WORK' })
    const r = await resolveAccount(fp, key, 'claude', 'work')
    expect(r).toEqual({ name: 'work', oauthToken: 'sk-ant-oat01-WORK' })
  })

  it('geen naam → default (AC-3)', async () => {
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    await addAccount(fp, key, { provider: 'claude', name: 'b', oauthToken: 'sk-ant-oat01-B', isDefault: true })
    expect((await resolveAccount(fp, key, 'claude'))?.name).toBe('b')
  })

  it('onbekend account → null (fail-closed, AC-6)', async () => {
    const fp = await newFp()
    expect(await resolveAccount(fp, key, 'claude', 'nope')).toBeNull()
  })

  it('verkeerde sleutel → decrypt faalt → null (AC-6)', async () => {
    const fp = await newFp()
    await addAccount(fp, key, { provider: 'claude', name: 'a', oauthToken: 'sk-ant-oat01-A' })
    expect(await resolveAccount(fp, getRandomBytes(32), 'claude', 'a')).toBeNull()
  })
})
