import { describe, it, expect } from 'vitest'
import { computeSalesIncome, computeSalesIncomeByMonth, saleIncomeParts, salesIncomeNet, type SaleIncomeInput } from '../salesIncome'

function sale(o: Partial<SaleIncomeInput> = {}): SaleIncomeInput {
  return { sale_price: 100, fees: 13, shipping_cost: 5, shipping_charged: null, refunded_amount: 0, sold_at: '2026-03-04', deleted_at: undefined, ...o }
}

describe('saleIncomeParts', () => {
  it('eBay-style sale: gross = price, fees and platform labels are expenses', () => {
    expect(saleIncomeParts(sale())).toEqual({ grossReceipts: 100, returns: 0, fees: 13, platformShipping: 5 })
  })
  it('TCGplayer-style sale: buyer-paid shipping is income', () => {
    expect(saleIncomeParts(sale({ sale_price: 3.18, fees: 0.92, shipping_cost: null, shipping_charged: 1.49 })).grossReceipts).toBeCloseTo(4.67)
  })
  it('treats missing/negative magnitudes safely', () => {
    expect(saleIncomeParts(sale({ fees: -2, shipping_cost: undefined, refunded_amount: undefined }))).toEqual({ grossReceipts: 100, returns: 0, fees: 2, platformShipping: 0 })
  })
  it('net matches the eBay payout identity: price − fees − labels − refunds', () => {
    const t = computeSalesIncome([sale({ refunded_amount: 20 })])
    expect(salesIncomeNet(t)).toBe(62)
  })
})

describe('computeSalesIncome', () => {
  it('sums sales, skips deleted, adds bundle fees/shipping once', () => {
    const t = computeSalesIncome(
      [sale(), sale({ sale_price: 50, fees: 0, shipping_cost: null }), sale({ deleted_at: '2026-04-01' })],
      [{ fees: 7, shipping_cost: 3, sold_at: '2026-03-05' }, { fees: 99, shipping_cost: 99, sold_at: '2026-03-05', deleted_at: 'x' }],
    )
    expect(t).toEqual({ grossReceipts: 150, returns: 0, fees: 20, platformShipping: 8, saleCount: 2 })
  })
  it('a full return keeps gross and puts the refund in returns', () => {
    const t = computeSalesIncome([sale({ refunded_amount: 100, fees: 0, shipping_cost: 0 })])
    expect([t.grossReceipts, t.returns, salesIncomeNet(t)]).toEqual([100, 100, 0])
  })
})

describe('computeSalesIncomeByMonth', () => {
  it('buckets sales and bundles by sold_at month (timestamps ok)', () => {
    const m = computeSalesIncomeByMonth([sale({ sold_at: '2026-03-31T23:00:00Z' }), sale({ sold_at: '2026-04-01' })], [{ fees: 1, shipping_cost: 0, sold_at: '2026-04-02' }])
    expect(Object.keys(m).sort()).toEqual(['2026-03', '2026-04'])
    expect(m['2026-04'].fees).toBe(14)
  })
})
