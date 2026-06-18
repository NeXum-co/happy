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
import { chooseBurnAccount, type BurnPolicyConfig } from '@/accounts/burnPolicy'
import type { AccountUsage } from '@/accounts/usageStore'

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
  /** S6: burn-policy + laatst-geziene usage; samen sturen ze de account-keuze als er geen expliciete is. */
  burnPolicy?: BurnPolicyConfig
  usage?: Record<string, AccountUsage>
}

export type BindingResult =
  | { ok: true; stripApiKey: boolean; binding?: { routingKey: string; account: string }; warning?: string }
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

  // S6: zonder expliciete keuze + actieve burn-policy → kies het eerste account
  // onder de drempel. Álle accounts vol → escaleer: warn + val terug op de default
  // (D-E10-19, niet weigeren). Een expliciete keuze slaat de policy over.
  let chosen = explicit
  let warning: string | undefined
  if (!explicit && deps.burnPolicy?.enabled) {
    const decision = chooseBurnAccount(deps.usage ?? {}, deps.burnPolicy)
    if (decision.kind === 'selected') chosen = decision.account
    else if (decision.kind === 'escalate') {
      warning = `burn-policy: geen account onder de drempel (${Math.round(deps.burnPolicy.thresholdPct * 100)}%) — terugval op het default-account`
    }
  }

  const resolved = await resolveAccount(deps.vaultFile, deps.masterKey, PROVIDER, chosen)
  if (!resolved) {
    const which = chosen ? `account '${chosen}'` : 'default account'
    return { ok: false, error: `kan ${which} (${PROVIDER}) niet ontsleutelen — spawn geweigerd (fail-closed)` }
  }

  const routingKey = (deps.mintKey ?? (() => `rk-${encodeBase64(getRandomBytes(18))}`))()
  deps.proxy.register(routingKey, { account: resolved.name, realToken: resolved.oauthToken })
  extraEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${deps.proxy.port}`
  extraEnv.ANTHROPIC_AUTH_TOKEN = routingKey
  // Geef de routing-key + account terug zodat de daemon ze op de TrackedSession
  // bewaart en de sessie later live kan switchen (S3 accountSwitch via remap).
  return { ok: true, stripApiKey: true, binding: { routingKey, account: resolved.name }, warning }
}
