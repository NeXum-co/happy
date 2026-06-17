/**
 * burnPolicy — instelbare burn-volgorde + drempel (E10 S6, AC-8, D-E10-8).
 *
 * Twee pure beslis-functies, gevoed door de usageStore-snapshot (S4) en een
 * persisted config (in de vault). Geen daemon/proxy/IO-import — deterministisch,
 * deps als argument (zoals applyAccountSwitch / createUsageStore).
 *
 * - `chooseBurnAccount`: bij een nieuwe cloud-spawn zónder expliciet account kiest
 *   de policy het eerste account in de volgorde dat nóg ruimte heeft (utilisatie
 *   onder de drempel). Geen enkel account onder de drempel → `escalate` (de caller
 *   logt een warning en valt terug op het default-account, D-E10-19).
 * - `planBurnRemap`: lopende sessies waarvan het account de drempel raakt verschuiven
 *   naar het volgende account met ruimte (toegepast via accountSwitch, D-E10-20).
 *
 * Fail-soft (D-E10-6): een account dat de proxy nog nooit zag (`null`-usage) telt als
 * 0% benut → beschikbaar. `null` betekent "nooit gezien", nooit "uitgeput" → veilig
 * naar voren te burnen. We blokkeren nooit op afwezige data.
 */
import type { AccountUsage } from '@/accounts/usageStore'

export interface BurnPolicyConfig {
  /** Staat de policy aan? Uit → ongewijzigd huidig gedrag (default-fallback). */
  enabled: boolean
  /** Account-namen in burn-prioriteit (eerste = eerst opbranden). */
  order: string[]
  /** Drempel als fractie 0..1 (0.9 = 90%); een account is "vol" bij util >= drempel. */
  thresholdPct: number
}

export type BurnDecision =
  | { kind: 'inactive' }                  // policy uit of lege volgorde → val terug op huidig gedrag
  | { kind: 'selected'; account: string } // eerste account onder de drempel
  | { kind: 'escalate' }                  // álle accounts >= drempel → warn + default-fallback (D-E10-19)

/** Hoogste van de 5h/7d-utilisatie; nooit-gezien (`null`) = 0 (= ruimte). */
function util(usage: Record<string, AccountUsage>, account: string): number {
  const u = usage[account]
  if (!u) return 0
  return Math.max(u.fiveHourUtil ?? 0, u.sevenDayUtil ?? 0)
}

/** Eerste account in de volgorde met ruimte (util < drempel), of `null`. */
function firstWithRoom(
  usage: Record<string, AccountUsage>, config: BurnPolicyConfig,
): string | null {
  for (const account of config.order) {
    if (util(usage, account) < config.thresholdPct) return account
  }
  return null
}

/** Kies het burn-account voor een nieuwe spawn (geen expliciete keuze). */
export function chooseBurnAccount(
  usage: Record<string, AccountUsage>, config: BurnPolicyConfig,
): BurnDecision {
  if (!config.enabled || config.order.length === 0) return { kind: 'inactive' }
  const account = firstWithRoom(usage, config)
  return account ? { kind: 'selected', account } : { kind: 'escalate' }
}

/**
 * Remap-plan voor lopende sessies: per sessie waarvan het huidige account de drempel
 * raakt, het doel-account (eerste met ruimte) als dat verschilt van het huidige.
 * Geen doel (álle vol) → sessie niet in het plan (escalatie is een no-op: laat draaien).
 */
export function planBurnRemap(
  sessions: { sessionId: string; account: string }[],
  usage: Record<string, AccountUsage>, config: BurnPolicyConfig,
): { sessionId: string; toAccount: string }[] {
  if (!config.enabled || config.order.length === 0) return []
  const plan: { sessionId: string; toAccount: string }[] = []
  for (const { sessionId, account } of sessions) {
    if (util(usage, account) < config.thresholdPct) continue // huidige heeft nog ruimte
    const target = firstWithRoom(usage, config)
    if (target && target !== account) plan.push({ sessionId, toAccount: target })
  }
  return plan
}
