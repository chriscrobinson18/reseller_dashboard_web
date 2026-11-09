import { describe, it, expect } from 'vitest'
import { computePartIII, inventoryOnHandAsOf, type LotForValuation } from '../partIII'

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
