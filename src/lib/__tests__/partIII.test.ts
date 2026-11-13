import { describe, it, expect } from 'vitest'
import { computePartIII, inventoryOnHandAsOf, inventoryChangeForPeriod, inventoryChangeByMonth, monthKeysBetween, type LotForValuation } from '../partIII'

describe('computePartIII (traditional method)', () => {
  it('Line 42 = beginning (prior year row) + purchases − ending', () => {
    const p = computePartIII(2025, 89000, [{ tax_year: 2024, ending_inventory: 5000 }, { tax_year: 2025, ending_inventory: 20000 }])
    expect([p.beginningInventory, p.purchases, p.line40, p.endingInventory, p.cogs, p.complete]).toEqual([5000, 89000, 94000, 20000, 74000, true])
  })
  it('flags missing values and treats them as 0', () => {
    const p = computePartIII(2026, 1000, [{ tax_year: 2026, ending_inventory: 300 }])
    expect([p.beginningSet, p.endingSet, p.complete, p.cogs]).toEqual([false, true, false, 700])
  })
  it('accepts purchases as a negative signed sum', () => {
    expect(computePartIII(2025, -500, []).purchases).toBe(500)
  })
})

describe('inventoryOnHandAsOf', () => {
  const lot = (o: Partial<LotForValuation>): LotForValuation => ({ id: 'L1', quantity_remaining: 0, unit_cost: 10, purchase_date: '2025-06-01', created_at: '2025-06-01T00:00:00Z', ...o })
  it('adds back units sold after the date and skips lots bought after it', () => {
    const r = inventoryOnHandAsOf(
      [lot({ id: 'A', quantity_remaining: 2 }), lot({ id: 'B', quantity_remaining: 5, purchase_date: '2026-01-05' }), lot({ id: 'C', quantity_remaining: 0, unit_cost: 50 })],
      [
        { inventory_lot_id: 'A', quantity: 3, sold_at: '2026-02-01' },   // sold after Dec 31 → was on hand
        { inventory_lot_id: 'A', quantity: 4, sold_at: '2025-11-01' },   // sold before → not on hand
        { inventory_lot_id: 'C', quantity: 1, sold_at: '2026-01-10T15:00:00Z' },
      ],
      '2025-12-31',
    )
    expect(r).toEqual({ value: 5 * 10 + 1 * 50, units: 6, lotCount: 2 })
  })
  it('uses created_at when purchase_date is missing and ignores deleted lots', () => {
    const r = inventoryOnHandAsOf(
      [lot({ id: 'A', quantity_remaining: 1, purchase_date: null, created_at: '2025-03-01T00:00:00Z' }), lot({ id: 'D', quantity_remaining: 9, deleted_at: 'x' })],
      [], '2025-12-31')
    expect(r.value).toBe(10)
  })
})

describe('inventoryChangeForPeriod', () => {
  const lot = (o: Partial<LotForValuation>): LotForValuation => ({ id: 'L1', quantity_remaining: 0, unit_cost: 10, purchase_date: '2025-06-01', created_at: '2025-06-01T00:00:00Z', ...o })
  // A: 10 @ $10 bought 2025-06-01; 4 sold 2025-11-01, 3 sold 2026-03-15 → 3 left
  // B:  5 @ $20 bought 2026-02-01; 2 sold 2026-04-10              → 3 left
  const lots = [lot({ id: 'A', quantity_remaining: 3 }), lot({ id: 'B', quantity_remaining: 3, unit_cost: 20, purchase_date: '2026-02-01' })]
  const movements = [
    { inventory_lot_id: 'A', quantity: 4, sold_at: '2025-11-01T12:00:00Z' },
    { inventory_lot_id: 'A', quantity: 3, sold_at: '2026-03-15T12:00:00Z' },
    { inventory_lot_id: 'B', quantity: 2, sold_at: '2026-04-10T12:00:00Z' },
  ]

  it('beginning = day before start, ending capped at today; COGS identity holds', () => {
    const r = inventoryChangeForPeriod(lots, movements, '2026-01-01', '2026-12-31', '2026-11-13')
    expect(r).toEqual({ beginning: 60, ending: 90, change: 30, beginningAsOf: '2025-12-31', endingAsOf: '2026-11-13' })
    // beginning + purchases (B: 5 × $20) − ending === cost of units sold in the period (3×$10 + 2×$20)
    expect(r.beginning + 100 - r.ending).toBe(70)
  })

  it('uses the period end when it is in the past', () => {
    const r = inventoryChangeForPeriod(lots, movements, '2026-01-01', '2026-03-31', '2026-11-13')
    expect([r.ending, r.endingAsOf]).toEqual([3 * 10 + 5 * 20, '2026-03-31'])
  })

  it('all-time has no beginning inventory', () => {
    const r = inventoryChangeForPeriod(lots, movements, null, null, '2026-11-13')
    expect([r.beginning, r.beginningAsOf, r.ending, r.change]).toEqual([0, null, 90, 90])
  })

  it('steps back across a month boundary for the beginning date', () => {
    expect(inventoryChangeForPeriod(lots, movements, '2026-03-01', null, '2026-11-13').beginningAsOf).toBe('2026-02-28')
  })
})

describe('computePartIII estimates', () => {
  it('fills missing values from estimates, but a saved value always wins', () => {
    const p = computePartIII(2026, 1000, [{ tax_year: 2025, ending_inventory: 400 }], { beginning: 999, ending: 300 })
    expect([p.beginningInventory, p.beginningEstimated, p.endingInventory, p.endingEstimated, p.cogs, p.complete])
      .toEqual([400, false, 300, true, 1100, false])
  })
  it('without estimates behaves as before', () => {
    const p = computePartIII(2026, 1000, [])
    expect([p.beginningInventory, p.endingInventory, p.beginningEstimated, p.endingEstimated]).toEqual([0, 0, false, false])
  })
})

describe('monthly inventory change', () => {
  const lot = (o: Partial<LotForValuation>): LotForValuation => ({ id: 'L1', quantity_remaining: 0, unit_cost: 10, purchase_date: '2025-06-01', created_at: '2025-06-01T00:00:00Z', ...o })
  it('lists months across a year boundary', () => {
    expect(monthKeysBetween('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })
  it('monthly changes telescope to the period change', () => {
    const lots = [lot({ id: 'A', quantity_remaining: 3 }), lot({ id: 'B', quantity_remaining: 3, unit_cost: 20, purchase_date: '2026-02-01' })]
    const mv = [{ inventory_lot_id: 'A', quantity: 3, sold_at: '2026-03-15' }, { inventory_lot_id: 'B', quantity: 2, sold_at: '2026-04-10' }]
    const byMonth = inventoryChangeByMonth(lots, mv, monthKeysBetween('2026-01', '2026-05'), '2026-05-20')
    expect(byMonth).toEqual({ '2026-01': 0, '2026-02': 100, '2026-03': -30, '2026-04': -40, '2026-05': 0 })
    const sum = Object.values(byMonth).reduce((a, b) => a + b, 0)
    expect(sum).toBe(inventoryChangeForPeriod(lots, mv, '2026-01-01', '2026-05-31', '2026-05-20').change)
  })
})
