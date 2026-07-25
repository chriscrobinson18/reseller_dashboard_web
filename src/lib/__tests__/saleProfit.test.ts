import { describe, it, expect } from 'vitest'
import { saleProfit } from '../saleProfit'
import type { Sale } from '../types'

function sale(overrides: Partial<Sale> = {}): Sale {
  return {
    id: 's1', user_id: 'u1', source: 'manual', quantity: 1,
    sale_price: 100, fees: 10, shipping_cost: 5,
    inventory_status: 'ok', return_status: 'none',
    refunded_quantity: 0,
    sold_at: '2026-01-15T12:00:00Z', created_at: '2026-01-15T12:00:00Z',
    inventory_movements: [
      { id: 'm1', quantity: 1, inventory_lots: { unit_cost: 30, item_id: 'i1' } },
    ],
    ...overrides,
  }
}

describe('saleProfit', () => {
  it('computes profit for a no-return sale', () => {
    const result = saleProfit(sale())
    expect(result.cogs).toBe(30)
    expect(result.netRevenue).toBe(100)
    expect(result.profit).toBe(55)
  })

  it('subtracts refunded_amount for partial returns', () => {
    const result = saleProfit(sale({
      return_status: 'partial',
      refunded_amount: 40,
    }))
    expect(result.netRevenue).toBe(60)
    expect(result.profit).toBe(15)
  })

  it('ignores refunded_amount for full returns (sale is excluded upstream)', () => {
    const result = saleProfit(sale({
      return_status: 'full',
      refunded_amount: 100,
    }))
    expect(result.netRevenue).toBe(100)
    expect(result.profit).toBe(55)
  })

  it('handles missing inventory_movements (oversold) as cogs = 0', () => {
    const result = saleProfit(sale({ inventory_movements: [] }))
    expect(result.cogs).toBe(0)
    expect(result.profit).toBe(100 - 0 - 10 - 5)
  })

  it('handles missing fees/shipping_cost as 0', () => {
    const result = saleProfit(sale({ fees: 0, shipping_cost: undefined }))
    expect(result.profit).toBe(100 - 30 - 0 - 0)
  })

  // Bundle lines store fees=0/shipping=null because an order-level charge can't
  // belong to any single line; the allocated share is what makes them truthful.
  it('uses a bundle line\'s allocated share over its zeroed fees/shipping', () => {
    const result = saleProfit(sale({
      fees: 0,
      shipping_cost: null as unknown as undefined,
      allocated_fees: 12.5,
      allocated_shipping: 4,
    }))
    expect(result.profit).toBe(100 - 30 - 12.5 - 4)
  })

  it('prefers allocated values even when they are zero', () => {
    const result = saleProfit(sale({
      fees: 10,
      shipping_cost: 5,
      allocated_fees: 0,
      allocated_shipping: 0,
    }))
    expect(result.profit).toBe(100 - 30)
  })
})
