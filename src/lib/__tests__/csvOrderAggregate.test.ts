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

describe('csvOrderSaleFields (sync v7: gross price, refunds on refunded_amount)', () => {
  it('sale_price = gross; refunded_amount = refunds; net = gross − refunds − fees − postage; status from refunds', () => {
    const f = (gross: number, refunded: number) => csvOrderSaleFields({ grossRevenue: gross, refundedAmount: refunded, fees: 10, shippingCost: 5, date: '2025-01-01', productName: null })
    expect(f(100, 0)).toEqual({ sale_price: 100, refunded_amount: 0, fees: 10, shipping_cost: 5, net_payout: 85, return_status: 'none' })
    expect(f(100, 40)).toMatchObject({ sale_price: 100, refunded_amount: 40, net_payout: 45, return_status: 'partial' })
    // a fully refunded order keeps its gross price (Line 1) with the refund on Line 2, instead of a $0 price
    expect(f(100, 100)).toMatchObject({ sale_price: 100, refunded_amount: 100, net_payout: -15, return_status: 'full' })
  })

  it('real Amazon case: $90.88 order with a $13.63 partial refund keeps the gross on Line 1 and the refund visible', () => {
    const f = csvOrderSaleFields({ grossRevenue: 90.88, refundedAmount: 13.63, fees: 13.39, shippingCost: 10.6, date: '2026-08-07', productName: 'LP' })
    expect(f).toMatchObject({ sale_price: 90.88, refunded_amount: 13.63, return_status: 'partial', net_payout: 53.26 })
  })
})
