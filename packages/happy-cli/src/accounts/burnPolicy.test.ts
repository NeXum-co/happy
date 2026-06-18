import { describe, it, expect } from 'vitest'
import { chooseBurnAccount, planBurnRemap, type BurnPolicyConfig } from '@/accounts/burnPolicy'
import type { AccountUsage } from '@/accounts/usageStore'

const u = (fiveHourUtil: number | null, sevenDayUtil: number | null = null): AccountUsage =>
  ({ fiveHourUtil, sevenDayUtil, seenAt: 1000 })

const cfg = (over: Partial<BurnPolicyConfig> = {}): BurnPolicyConfig =>
  ({ enabled: true, order: ['a', 'b', 'c'], thresholdPct: 0.9, ...over })

describe('chooseBurnAccount', () => {
  it('TC-1: inactive bij disabled', () => {
    expect(chooseBurnAccount({}, cfg({ enabled: false }))).toEqual({ kind: 'inactive' })
  })

  it('TC-2: inactive bij lege volgorde', () => {
    expect(chooseBurnAccount({ a: u(0.99) }, cfg({ order: [] }))).toEqual({ kind: 'inactive' })
  })

  it('TC-3: selected = eerste account onder de drempel (eerder account zit erboven)', () => {
    const usage = { a: u(0.95), b: u(0.10) }
    expect(chooseBurnAccount(usage, cfg())).toEqual({ kind: 'selected', account: 'b' })
  })

  it('TC-4: escalate als álle accounts >= drempel', () => {
    const usage = { a: u(0.95), b: u(0.91), c: u(0.90) }
    expect(chooseBurnAccount(usage, cfg())).toEqual({ kind: 'escalate' })
  })

  it('TC-5: null-usage telt als ruimte (account zonder snapshot wordt geselecteerd)', () => {
    const usage = { a: u(0.95) } // b/c nooit gezien
    expect(chooseBurnAccount(usage, cfg())).toEqual({ kind: 'selected', account: 'b' })
  })

  it('TC-6: drempel-grens — util === drempel is vol (>=), net eronder is ruimte', () => {
    expect(chooseBurnAccount({ a: u(0.9), b: u(0.10) }, cfg())).toEqual({ kind: 'selected', account: 'b' })
    expect(chooseBurnAccount({ a: u(0.8999), b: u(0.10) }, cfg())).toEqual({ kind: 'selected', account: 'a' })
  })

  it('TC-7: hoogste van 5h/7d telt (7d boven drempel → vol)', () => {
    const usage = { a: u(0.10, 0.95), b: u(0.10, 0.10) }
    expect(chooseBurnAccount(usage, cfg())).toEqual({ kind: 'selected', account: 'b' })
  })
})

describe('planBurnRemap', () => {
  it('TC-8: sessie op een vol account → remap naar het volgende met ruimte', () => {
    const usage = { a: u(0.95), b: u(0.10) }
    const plan = planBurnRemap([{ sessionId: 's1', account: 'a' }], usage, cfg())
    expect(plan).toEqual([{ sessionId: 's1', toAccount: 'b' }])
  })

  it('TC-9: sessie op een account met ruimte → geen remap', () => {
    const usage = { a: u(0.10), b: u(0.10) }
    expect(planBurnRemap([{ sessionId: 's1', account: 'a' }], usage, cfg())).toEqual([])
  })

  it('TC-10: remap kiest het eerste account met ruimte in de volgorde (niet zomaar een)', () => {
    const usage = { a: u(0.95), b: u(0.20), c: u(0.05) } // b én c hebben ruimte; b komt eerst
    const plan = planBurnRemap([{ sessionId: 's1', account: 'a' }], usage, cfg())
    expect(plan).toEqual([{ sessionId: 's1', toAccount: 'b' }])
  })

  it('TC-11: geen doel (álle vol) → leeg plan (escalatie = laat draaien)', () => {
    const usage = { a: u(0.95), b: u(0.92), c: u(0.91) }
    expect(planBurnRemap([{ sessionId: 's1', account: 'a' }], usage, cfg())).toEqual([])
  })

  it('TC-12: meerdere sessies, gemengd', () => {
    const usage = { a: u(0.95), b: u(0.10), c: u(0.05) }
    const plan = planBurnRemap(
      [{ sessionId: 's1', account: 'a' }, { sessionId: 's2', account: 'b' }, { sessionId: 's3', account: 'a' }],
      usage, cfg(),
    )
    expect(plan).toEqual([{ sessionId: 's1', toAccount: 'b' }, { sessionId: 's3', toAccount: 'b' }])
  })

  it('TC-13: disabled → leeg plan', () => {
    const usage = { a: u(0.95), b: u(0.10) }
    expect(planBurnRemap([{ sessionId: 's1', account: 'a' }], usage, cfg({ enabled: false }))).toEqual([])
  })
})
