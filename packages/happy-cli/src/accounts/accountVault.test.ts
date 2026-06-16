import { describe, it, expect } from 'vitest'
import { vaultMasterKey, loadVault, saveVault } from '@/accounts/accountVault'
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
