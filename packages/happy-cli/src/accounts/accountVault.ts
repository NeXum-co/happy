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

export type AccountInfo = { name: string; isDefault: boolean; addedAt: number }

function ensureProvider(v: VaultData, provider: string) {
  v.providers[provider] ??= { defaultAccount: null, accounts: {} }
  return v.providers[provider]
}

export async function addAccount(
  filePath: string, masterKey: Uint8Array,
  opts: { provider: string; name: string; oauthToken: string; isDefault?: boolean },
): Promise<void> {
  const v = await loadVault(filePath)
  const p = ensureProvider(v, opts.provider)
  p.accounts[opts.name] = {
    oauthTokenEnc: encodeBase64(encrypt(masterKey, 'dataKey', opts.oauthToken)),
    addedAt: Date.now(),
  }
  if (opts.isDefault || !p.defaultAccount) p.defaultAccount = opts.name
  await saveVault(filePath, v)
}

export async function listAccounts(filePath: string, provider: string): Promise<AccountInfo[]> {
  const p = (await loadVault(filePath)).providers[provider]
  if (!p) return []
  return Object.entries(p.accounts).map(([name, a]) => ({
    name, isDefault: p.defaultAccount === name, addedAt: a.addedAt,
  }))
}

export async function removeAccount(filePath: string, provider: string, name: string): Promise<void> {
  const v = await loadVault(filePath)
  const p = v.providers[provider]
  if (!p?.accounts[name]) return
  delete p.accounts[name]
  if (p.defaultAccount === name) p.defaultAccount = Object.keys(p.accounts)[0] ?? null
  await saveVault(filePath, v)
}

export async function setDefaultAccount(filePath: string, provider: string, name: string): Promise<void> {
  const v = await loadVault(filePath)
  const p = v.providers[provider]
  if (!p?.accounts[name]) throw new Error(`onbekend account ${provider}/${name}`)
  p.defaultAccount = name
  await saveVault(filePath, v)
}

export type ResolvedAccount = { name: string; oauthToken: string }

/** Resolve naar { name, oauthToken } of null. Expliciete naam > default. */
export async function resolveAccount(
  filePath: string, masterKey: Uint8Array, provider: string, accountName?: string,
): Promise<ResolvedAccount | null> {
  const p = (await loadVault(filePath)).providers[provider]
  if (!p) return null
  const name = accountName ?? p.defaultAccount ?? undefined
  if (!name) return null
  const acct = p.accounts[name]
  if (!acct) return null
  const token = decrypt(masterKey, 'dataKey', decodeBase64(acct.oauthTokenEnc))
  if (typeof token !== 'string') return null // fail-closed
  return { name, oauthToken: token }
}
