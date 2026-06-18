/**
 * accountSwitch — live-switch (AC-4): remap een gekozen set lopende cloud-sessies
 * naar één Claude-account door de authProxy-routing te herschrijven (geen respawn,
 * geen file-race). Pure functie met expliciete deps (zoals accountBinding): resolve
 * het doel-account één keer (fail-closed bij null — nul remaps, AC-6), dan per sessie
 * de routing-key opzoeken en remappen. Een sessie zonder routing-key (ongebonden /
 * terminal) komt in `skipped`, nooit een fout die de batch kapt.
 */
import { resolveAccount } from '@/accounts/accountVault'

export interface SwitchProxy {
  remap(routingKey: string, route: { account: string; realToken: string }): void
}

export interface SwitchDeps {
  vaultFile: string
  masterKey: Uint8Array
  proxy: SwitchProxy
  lookupRoutingKey: (sessionId: string) => string | undefined
}

export type SwitchResult =
  | { ok: true; remapped: string[]; skipped: string[] }
  | { ok: false; error: string }

const PROVIDER = 'claude' // v1: alleen Claude (D-E10-9)

export async function applyAccountSwitch(
  sessionIds: string[], opts: { account: string }, deps: SwitchDeps,
): Promise<SwitchResult> {
  // Doel-account één keer resolven vóór enige remap (fail-closed, AC-6).
  const resolved = await resolveAccount(deps.vaultFile, deps.masterKey, PROVIDER, opts.account)
  if (!resolved) {
    return { ok: false, error: `kan account '${opts.account}' (${PROVIDER}) niet ontsleutelen — switch geweigerd (fail-closed)` }
  }

  const route = { account: resolved.name, realToken: resolved.oauthToken }
  const remapped: string[] = []
  const skipped: string[] = []
  for (const sessionId of sessionIds) {
    const routingKey = deps.lookupRoutingKey(sessionId)
    if (!routingKey) {
      skipped.push(sessionId)
      continue
    }
    deps.proxy.remap(routingKey, route)
    remapped.push(sessionId)
  }
  return { ok: true, remapped, skipped }
}
