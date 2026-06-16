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
