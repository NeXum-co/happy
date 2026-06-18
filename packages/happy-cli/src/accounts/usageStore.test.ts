import { describe, it, expect } from 'vitest'
import { createUsageStore } from '@/accounts/usageStore'

const H5 = 'anthropic-ratelimit-unified-5h-utilization'
const H7 = 'anthropic-ratelimit-unified-7d-utilization'

describe('usageStore', () => {
  it('TC-1: record 5h+7d → snapshot toont beide + seenAt (AC-5)', () => {
    const store = createUsageStore(() => 1000)
    store.record('work', { [H5]: '0.42', [H7]: '0.10' })
    expect(store.snapshot()).toEqual({ work: { fiveHourUtil: 0.42, sevenDayUtil: 0.10, seenAt: 1000 } })
  })

  it('TC-2: fail-soft — geen unified-headers → geen phantom-entry (D-E10-6)', () => {
    const store = createUsageStore(() => 1000)
    store.record('work', { 'content-type': 'text/event-stream' })
    expect(store.snapshot()).toEqual({})
  })

  it('TC-3: behoud — latere response zonder headers overschrijft een eerdere waarde niet', () => {
    let t = 1000
    const store = createUsageStore(() => t)
    store.record('work', { [H5]: '0.42', [H7]: '0.10' })
    t = 2000
    store.record('work', {}) // geen signaal → niets bijwerken
    expect(store.snapshot().work).toEqual({ fiveHourUtil: 0.42, sevenDayUtil: 0.10, seenAt: 1000 })
  })

  it('TC-4: partial — alleen 5h gezien → 7d blijft null', () => {
    const store = createUsageStore(() => 1000)
    store.record('work', { [H5]: '0.42' })
    expect(store.snapshot().work).toEqual({ fiveHourUtil: 0.42, sevenDayUtil: null, seenAt: 1000 })
  })

  it('TC-5: niet-numerieke header → fail-soft null (nooit een verzonnen getal)', () => {
    const store = createUsageStore(() => 1000)
    store.record('work', { [H5]: 'n/a', [H7]: '0.10' })
    expect(store.snapshot().work).toEqual({ fiveHourUtil: null, sevenDayUtil: 0.10, seenAt: 1000 })
  })
})
