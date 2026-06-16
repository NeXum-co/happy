/**
 * accountBinding — bindt een cloud-spawn aan een Claude-account via de authProxy.
 * Engaged alleen als account-routing in gebruik is (expliciet account óf een
 * geconfigureerde default; D-E10-13). Engaged → muteer de spawn-env naar de proxy
 * (routing-key i.p.v. echt token; AC-7) en registreer key→{account,token}. Niet
 * engaged → passthrough (backward-compat). Engaged maar resolve faalt → fail-closed
 * (AC-6): de caller weigert de spawn, nooit stil op een verkeerd account.
 * Local presets (ANTHROPIC_BASE_URL al gezet) en niet-claude agents worden overgeslagen.
 */
import { encodeBase64, getRandomBytes } from '@/api/encryption'
import { listAccounts, resolveAccount } from '@/accounts/accountVault'

export interface BindingProxy {
  readonly port: number
  register(routingKey: string, route: { account: string; realToken: string }): void
}

export interface BindingOpts {
  agent?: 'claude' | 'codex' | 'gemini' | 'openclaw'
  account?: string
}

export interface BindingDeps {
  vaultFile: string
  masterKey: Uint8Array
  proxy: BindingProxy
  mintKey?: () => string
}

export type BindingResult =
  | { ok: true; stripApiKey: boolean; binding?: { routingKey: string; account: string } }
  | { ok: false; error: string }

const PROVIDER = 'claude' // v1: alleen Claude (D-E10-9)

export async function applyAccountBinding(
  extraEnv: Record<string, string>, opts: BindingOpts, deps: BindingDeps,
): Promise<BindingResult> {
  // Niet-claude of een local-preset-spawn (base-url al gezet) → ongemoeid.
  if ((opts.agent ?? 'claude') !== 'claude') return { ok: true, stripApiKey: false }
  if (extraEnv.ANTHROPIC_BASE_URL) return { ok: true, stripApiKey: false }

  // Engaged? expliciet account, of een default in de vault.
  const explicit = opts.account
  const hasAccounts = (await listAccounts(deps.vaultFile, PROVIDER)).length > 0
  if (!explicit && !hasAccounts) return { ok: true, stripApiKey: false } // multi-subscriptie niet in gebruik

  const resolved = await resolveAccount(deps.vaultFile, deps.masterKey, PROVIDER, explicit)
  if (!resolved) {
    const which = explicit ? `account '${explicit}'` : 'default account'
    return { ok: false, error: `kan ${which} (${PROVIDER}) niet ontsleutelen — spawn geweigerd (fail-closed)` }
  }

  const routingKey = (deps.mintKey ?? (() => `rk-${encodeBase64(getRandomBytes(18))}`))()
  deps.proxy.register(routingKey, { account: resolved.name, realToken: resolved.oauthToken })
  extraEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${deps.proxy.port}`
  extraEnv.ANTHROPIC_AUTH_TOKEN = routingKey
  // Geef de routing-key + account terug zodat de daemon ze op de TrackedSession
  // bewaart en de sessie later live kan switchen (S3 accountSwitch via remap).
  return { ok: true, stripApiKey: true, binding: { routingKey, account: resolved.name } }
}
