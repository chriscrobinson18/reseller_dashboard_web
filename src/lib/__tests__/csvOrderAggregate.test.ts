import { describe, it, expect } from 'vitest'
import { aggregateCsvOrders, csvOrderSaleFields, type CsvOrderRow } from '../../../supabase/functions/_shared/csvOrderAggregate'

const row = (notes: string, cat: string, amount: number | string, date = '2025-12-01', merchant: string | null = null): CsvOrderRow =>
  ({ notes, schedule_c_category: cat, amount, date, merchant })

describe('aggregateCsvOrders (sync_csv_orders_to_sales v6)', () => {
  it('postage is signed: a positive postage credit REDUCES shipping cost (regression, v1–v5 used Math.abs)', () => {
    const m = aggregateCsvOrders([
      row('A', 'payout', 50), row('A', 'shipping_postage', -10), row('A', 'shipping_postage', 8.53, '2026-01-28'),
    ])
    expect(m.get('A')!.shippingCost).toBeCloseTo(1.47, 10)
  })

  it('reproduces the real 2025 case: −0.86 charge and +8.53 credit move net by +7.67, not −9.39', () => {
    const base = [row('X', 'payout', 100), row('X', 'commissions_fees', -15), row('X', 'shipping_postage', -5)]
    const before = csvOrderSaleFields(aggregateCsvOrders(base).get('X')!).net_payout
    const after = csvOrderSaleFields(aggregateCsvOrders([
      ...base, row('X', 'shipping_postage', -0.86, '2026-01-08'), row('X', 'shipping_postage', 8.53, '2026-01-28'),
    ]).get('X')!).net_payout
    expect(after - before).toBeCloseTo(7.67, 10)
  })

  it('fees are signed (reversal reduces fees); refunds are positive magnitudes', () => {
    const e = aggregateCsvOrders([
      row('B', 'payout', 100), row('B', 'commissions_fees', -15), row('B', 'commissions_fees', 3), row('B', 'payout', -40),
    ]).get('B')!
    expect([e.grossRevenue, e.fees, e.refundedAmount]).toEqual([100, 12, 40])
  })

  it('dates the sale by its earliest positive payout and names it from that row', () => {
    const e = aggregateCsvOrders([
      row('C', 'shipping_postage', -2, '2025-03-01'),
      row('C', 'payout', 10, '2025-03-05', 'Widget'),
      row('C', 'payout', 5, '2025-03-09', 'Other'),
    ]).get('C')!
    expect([e.date, e.productName, e.grossRevenue]).toEqual(['2025-03-01', 'Widget', 15])
  })

  it('skips rows with no order ref and transfer / settlement / tax / balance rows', () => {
    const m = aggregateCsvOrders([
      row('', 'payout', 1), row('--', 'payout', 1), { ...row('x', 'payout', 1), notes: null },
      row('D', 'transfer', 99), row('D', 'settlement', 99), row('D', 'taxes_licenses', -9), row('D', 'balance_adjustment', 9),
    ])
    expect(m.size).toBe(0)
  })

  it('accepts numeric strings from PostgREST', () => {
    expect(aggregateCsvOrders([row('E', 'payout', '12.50')]).get('E')!.grossRevenue).toBe(12.5)
  })
})

describe('csvOrderSaleFields (semantics unchanged since v4)', () => {
  it('sale_price = gross − refunds; net = price − fees − postage; return status from refunds', () => {
    const f = (gross: number, refunded: number) => csvOrderSaleFields({ grossRevenue: gross, refundedAmount: refunded, fees: 10, shippingCost: 5, date: '2025-01-01', productName: null })
    expect(f(100, 0)).toEqual({ sale_price: 100, fees: 10, shipping_cost: 5, net_payout: 85, return_status: 'none' })
    expect(f(100, 40).return_status).toBe('partial')
    expect(f(100, 100)).toMatchObject({ sale_price: 0, net_payout: -15, return_status: 'full' })
  })
})
