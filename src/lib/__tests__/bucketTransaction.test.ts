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
    ...overrides,
  }
}

describe('bucketTransaction', () => {
  it('routes an expense into the expense bucket with negative signedAmount', () => {
    const result = bucketTransaction(tx({ amount: -50, schedule_c_category: 'supplies' }))
    expect(result).toEqual({ bucket: 'expense', categoryValue: 'supplies', signedAmount: -50 })
  })

  it('routes a refund posted to an expense category as positive signed (offsetting)', () => {
    const result = bucketTransaction(tx({ amount: 50, schedule_c_category: 'supplies' }))
    expect(result).toEqual({ bucket: 'expense', categoryValue: 'supplies', signedAmount: 50 })
  })

  it('routes Part I income with positive signedAmount', () => {
    const result = bucketTransaction(tx({ amount: 200, schedule_c_category: 'payout' }))
    expect(result).toEqual({ bucket: 'income', categoryValue: 'payout', signedAmount: 200 })
  })

  it('routes Part III as cogs bucket', () => {
    const result = bucketTransaction(tx({ amount: -75, schedule_c_category: 'cost_of_goods' }))
    expect(result).toEqual({ bucket: 'cogs', categoryValue: 'cost_of_goods', signedAmount: -75 })
  })

  it('applies meals 50% multiplier to signedAmount', () => {
    const result = bucketTransaction(tx({ amount: -100, schedule_c_category: 'meals' }))
    expect(result).toEqual({ bucket: 'expense', categoryValue: 'meals', signedAmount: -50 })
  })

  it('applies meals 50% multiplier to refunds as well', () => {
    const result = bucketTransaction(tx({ amount: 100, schedule_c_category: 'meals' }))
    expect(result).toEqual({ bucket: 'expense', categoryValue: 'meals', signedAmount: 50 })
  })

  it('filters settlements (record_type)', () => {
    const result = bucketTransaction(tx({ record_type: 'settlement' }))
    expect(result.bucket).toBeNull()
  })

  it('filters transactions with related_sale_id (sale-derived)', () => {
    const result = bucketTransaction(tx({ related_sale_id: 's1' }))
    expect(result.bucket).toBeNull()
  })

  it('filters csv_import transactions', () => {
    const result = bucketTransaction(tx({ source: 'csv_import' }))
    expect(result.bucket).toBeNull()
  })

  it('filters net-zero paired transactions', () => {
    const result = bucketTransaction(tx({ net_zero_pair_id: 'p1' }))
    expect(result.bucket).toBeNull()
  })

  it('filters uncategorized transactions', () => {
    const result = bucketTransaction(tx({ schedule_c_category: undefined }))
    expect(result.bucket).toBeNull()
  })

  it('filters isExcluded categories (transfer/personal/etc.)', () => {
    const result = bucketTransaction(tx({ schedule_c_category: 'transfer' }))
    expect(result.bucket).toBeNull()
  })

  it('routes returns_allowances as income bucket (offsets Part I gross receipts)', () => {
    const result = bucketTransaction(tx({ amount: -30, schedule_c_category: 'returns_allowances' }))
    expect(result).toEqual({ bucket: 'income', categoryValue: 'returns_allowances', signedAmount: -30 })
  })
})
