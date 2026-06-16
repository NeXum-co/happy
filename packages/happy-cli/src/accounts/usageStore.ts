/**
 * usageStore — per-account laatst-geziene 5h/7d-utilisatie (E10 S4, AC-5).
 *
 * Gevoed door de authProxy (via een onResponse-callback; de proxy importeert deze
 * module NIET — D-E10-14, proxy blijft dom), gelezen door de app via een control-
 * endpoint + RPC. Fail-soft (D-E10-6): een ontbrekende/niet-numerieke header laat het
 * veld op `null`; een eerder-geziene waarde wordt nooit overschreven door een latere
 * response zonder de header. Usage = percentages (groen), geen tokens — AC-7 ongemoeid.
 *
 * De `unified-*`-utilisatie-headers zijn fracties (0..1, bv. '0.42' = 42% benut).
 */

const HDR_5H = 'anthropic-ratelimit-unified-5h-utilization'
const HDR_7D = 'anthropic-ratelimit-unified-7d-utilization'

export interface AccountUsage {
  /** 5h-utilisatie als fractie 0..1, of `null` als nog nooit gezien. */
  fiveHourUtil: number | null
  /** 7d-utilisatie als fractie 0..1, of `null` als nog nooit gezien. */
  sevenDayUtil: number | null
  /** Epoch-ms van de laatste keer dat een veld werd bijgewerkt, of `null`. */
  seenAt: number | null
}

export interface UsageStore {
  record(account: string, headers: Record<string, unknown>): void
  snapshot(): Record<string, AccountUsage>
}

function parseUtil(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(n) ? n : null
}

export function createUsageStore(now: () => number = Date.now): UsageStore {
  const map = new Map<string, AccountUsage>()

  return {
    record(account, headers) {
      const fiveHour = parseUtil(headers[HDR_5H])
      const sevenDay = parseUtil(headers[HDR_7D])
      if (fiveHour === null && sevenDay === null) return // geen signaal → geen phantom-entry

      const prev = map.get(account) ?? { fiveHourUtil: null, sevenDayUtil: null, seenAt: null }
      map.set(account, {
        fiveHourUtil: fiveHour ?? prev.fiveHourUtil,
        sevenDayUtil: sevenDay ?? prev.sevenDayUtil,
        seenAt: now(),
      })
    },
    snapshot() {
      const out: Record<string, AccountUsage> = {}
      for (const [account, usage] of map) out[account] = { ...usage }
      return out
    },
  }
}
