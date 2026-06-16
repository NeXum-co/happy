/**
 * accountVault — versleutelde, provider-generieke account-store onder ~/.happy/.
 * Slaat per account alleen het OAuth-token versleuteld op; metadata is leesbaar.
 * Pure module: alle functies krijgen filePath + masterKey expliciet (testbaar).
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import * as z from 'zod'
import { deriveKey } from '@/utils/deriveKey'
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '@/api/encryption'
import type { Credentials } from '@/persistence'

const accountSchema = z.object({
  oauthTokenEnc: z.string().base64(),
  addedAt: z.number(),
})
const providerSchema = z.object({
  defaultAccount: z.string().nullish(),
  accounts: z.record(z.string(), accountSchema),
})
export const vaultSchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), providerSchema),
})
export type VaultData = z.infer<typeof vaultSchema>

const EMPTY_VAULT: VaultData = { version: 1, providers: {} }

/** Leidt de vault-sleutel af uit de master-secret in de credentials. */
export async function vaultMasterKey(creds: Credentials): Promise<Uint8Array> {
  const seed = creds.encryption.type === 'legacy' ? creds.encryption.secret : creds.encryption.machineKey
  return deriveKey(seed, 'Happy Accounts', ['vault'])
}

/** Leest + valideert de vault. Ontbrekend = leeg. Corrupt = throw (fail-closed, AC-6). */
export async function loadVault(filePath: string): Promise<VaultData> {
  if (!existsSync(filePath)) return structuredClone(EMPTY_VAULT)
  const raw = await readFile(filePath, 'utf8')
  return vaultSchema.parse(JSON.parse(raw)) // throwt op corrupt/onverwacht schema
}

/** Atomic write (tmp + rename), 0600. */
export async function saveVault(filePath: string, data: VaultData): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, JSON.stringify(vaultSchema.parse(data), null, 2), { mode: 0o600 })
  await rename(tmp, filePath)
}
