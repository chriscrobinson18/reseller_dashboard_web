import { describe, it, expect } from 'vitest'
import { bucketTransaction } from '../categories'
import type { Transaction } from '../types'

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    user_id: 'u1',
    date: '2026-01-15',
    amount: -50,
    source: 'manual',
    record_type: 'transaction',
    schedule_c_category: 'supplies',
    created_at: '2026-01-15T00:00:00Z',
    is_non_cash: false,
    ...overrides,
  }
}

describe('bucketTransaction', () => {
  it('routes an expense into the expense bucket with negative signedAmount', () => {
    const result = bucketTransaction(tx({ amount: -50, schedule_c_category: 'supplies' }), [])
    expect(result).toEqual({ bucket: 'expense', categoryValue: 'supplies', signedAmount: -50 })
  })

  it('routes a refund posted to an expense category as positive signed (offsetting)', () => {
    const result = bucketTransaction(tx({ amount: 50, schedule_c_category: 'supplies' }), [])
    expect(result).toEqual({ bucket: 'expense', categoryValue: 'supplies', signedAmount: 50 })
  })

  it('routes Part I income with positive signedAmount', () => {
    const result = bucketTransaction(tx({ amount: 200, schedule_c_category: 'payout' }), [])
    expect(result).toEqual({ bucket: 'income', categoryValue: 'payout', signedAmount: 200 })
  })

  it('routes Part III as cogs bucket', () => {
    const result = bucketTransaction(tx({ amount: -75, schedule_c_category: 'cost_of_goods' }), [])
    expect(result).toEqual({ bucket: 'cogs', categoryValue: 'cost_of_goods', signedAmount: -75 })
  })

  it('applies meals 50% multiplier to signedAmount', () => {
    const result = bucketTransaction(tx({ amount: -100, schedule_c_category: 'meals' }), [])
    expect(result).toEqual({ bucket: 'expense', categoryValue: 'meals', signedAmount: -50 })
  })

  it('applies meals 50% multiplier to refunds as well', () => {
    const result = bucketTransaction(tx({ amount: 100, schedule_c_category: 'meals' }), [])
    expect(result).toEqual({ bucket: 'expense', categoryValue: 'meals', signedAmount: 50 })
  })

  it('filters settlements (record_type)', () => {
    const result = bucketTransaction(tx({ record_type: 'settlement' }), [])
    expect(result.bucket).toBeNull()
  })

  it('filters transactions with related_sale_id (sale-derived)', () => {
    const result = bucketTransaction(tx({ related_sale_id: 's1' }), [])
    expect(result.bucket).toBeNull()
  })

  it('filters bundle-linked transactions (bundle income/fees come from sales + sale_bundles)', () => {
    const result = bucketTransaction(tx({ related_bundle_id: 'b1' }), [])
    expect(result.bucket).toBeNull()
  })

  it('filters a trade income leg (given-side sales carry it) but keeps the trade COGS leg', () => {
    expect(bucketTransaction(tx({ trade_id: 'tr1', amount: 3000, schedule_c_category: 'payout' }), []).bucket).toBeNull()
    const cogs = bucketTransaction(tx({ trade_id: 'tr1', amount: -3000, schedule_c_category: 'cost_of_goods' }), [])
    expect(cogs.bucket).toBe('cogs')
    expect(cogs.signedAmount).toBe(-3000)
  })

  it('filters csv_import transactions', () => {
    const result = bucketTransaction(tx({ source: 'csv_import' }), [])
    expect(result.bucket).toBeNull()
  })

  it('filters net-zero paired transactions', () => {
    const result = bucketTransaction(tx({ net_zero_pair_id: 'p1' }), [])
    expect(result.bucket).toBeNull()
  })

  it('filters uncategorized transactions', () => {
    const result = bucketTransaction(tx({ schedule_c_category: undefined }), [])
    expect(result.bucket).toBeNull()
  })

  it('filters isExcluded categories (transfer/personal/etc.)', () => {
    const result = bucketTransaction(tx({ schedule_c_category: 'transfer' }), [])
    expect(result.bucket).toBeNull()
  })

  it('routes returns_allowances as income bucket (offsets Part I gross receipts)', () => {
    const result = bucketTransaction(tx({ amount: -30, schedule_c_category: 'returns_allowances' }), [])
    expect(result).toEqual({ bucket: 'income', categoryValue: 'returns_allowances', signedAmount: -30 })
  })
})

describe('eBay store subscription: the one report row that counts (2026-11-13)', () => {
  const report = (o: Partial<Transaction>) => tx({ source: 'csv_import', platform: 'ebay', notes: undefined, ...o })
  it('counts the store subscription on Line 10', () => {
    const b = bucketTransaction(report({ amount: -30, schedule_c_category: 'commissions_fees', merchant: 'Store (Basic): Subscription Fee Oct 31-Nov 29' }), [])
    expect(b).toEqual({ bucket: 'expense', categoryValue: 'commissions_fees', signedAmount: -30 })
  })
  it('keeps every other report row out: labels without an order, card top-ups, holds, ads, insertion fees, Amazon fees', () => {
    const others: Partial<Transaction>[] = [
      { schedule_c_category: 'shipping_postage', merchant: 'eBay Shipping Label', amount: -12.5 },
      { schedule_c_category: 'other_expense', merchant: 'Charge for refund cost from Visa ending in 0000', amount: 1000 },
      { schedule_c_category: 'balance_adjustment', merchant: 'Hold placed', amount: -400 },
      { schedule_c_category: 'advertising', merchant: 'Promoted Listings - General fee', amount: -3 },
      { schedule_c_category: 'commissions_fees', merchant: 'Insertion Fee', amount: -0.35 },
      { schedule_c_category: 'commissions_fees', merchant: 'Store (Basic): Subscription Fee Jun', amount: -30, notes: '12-34567-89012' },
      { schedule_c_category: 'commissions_fees', merchant: 'Store (Basic): Subscription Fee Jun', amount: -30, platform: 'amazon' },
    ]
    for (const o of others) expect(bucketTransaction(report(o), []).bucket).toBeNull()
  })
})
