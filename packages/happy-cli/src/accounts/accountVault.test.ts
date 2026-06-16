import { describe, it, expect } from 'vitest'
import { vaultMasterKey } from '@/accounts/accountVault'
import type { Credentials } from '@/persistence'
import { getRandomBytes } from '@/api/encryption'

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
