import { describe, it, expect } from 'vitest'
import { computeScheduleC, computeKPIs, computeMonthlyChart } from '../scheduleCMath'
import type { Transaction } from '../types'

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', user_id: 'u1', date: '2026-01-15', amount: -50,
    source: 'manual', record_type: 'transaction',
    schedule_c_category: 'supplies',
    created_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

describe('computeScheduleC', () => {
  it('sums signed amounts per category', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: 'supplies' }),
      tx({ id: 'b', amount: -50, schedule_c_category: 'supplies' }),
      tx({ id: 'c', amount: -200, schedule_c_category: 'advertising' }),
    ])
    expect(totals).toEqual({ supplies: -150, advertising: -200 })
  })

  it('refund posted to expense category reduces the category total (regression)', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: 'supplies' }),
      tx({ id: 'b', amount: 30, schedule_c_category: 'supplies' }), // refund
    ])
    expect(totals).toEqual({ supplies: -70 })
  })

  it('applies meals 50%', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: 'meals' }),
    ])
    expect(totals).toEqual({ meals: -50 })
  })

  it('excludes settlements, csv_import, related_sale_id, net_zero pairs', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: 'supplies' }),
      tx({ id: 'b', amount: -50, schedule_c_category: 'supplies', record_type: 'settlement' }),
      tx({ id: 'c', amount: -50, schedule_c_category: 'supplies', source: 'csv_import' }),
      tx({ id: 'd', amount: -50, schedule_c_category: 'supplies', related_sale_id: 's1' }),
      tx({ id: 'e', amount: -50, schedule_c_category: 'supplies', net_zero_pair_id: 'p1' }),
    ])
    expect(totals).toEqual({ supplies: -100 })
  })

  it('excludes isExcluded categories', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -500, schedule_c_category: 'transfer' }),
      tx({ id: 'b', amount: -100, schedule_c_category: 'personal' }),
      tx({ id: 'c', amount: -50, schedule_c_category: 'supplies' }),
    ])
    expect(totals).toEqual({ supplies: -50 })
  })

  it('excludes uncategorized', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: undefined }),
    ])
    expect(totals).toEqual({})
  })
})

describe('computeKPIs', () => {
  it('sums income and expenses with signed amounts', () => {
    const result = computeKPIs([
      tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', amount: -200, schedule_c_category: 'supplies' }),
      tx({ id: 'c', amount: -100, schedule_c_category: 'advertising' }),
    ])
    expect(result.income).toBe(1000)
    expect(result.expenses).toBe(300)
    expect(result.net).toBe(700)
  })

  it('refund in expense category reduces expenses, does not inflate income (regression)', () => {
    const result = computeKPIs([
      tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', amount: -200, schedule_c_category: 'supplies' }),
      tx({ id: 'c', amount: 50, schedule_c_category: 'supplies' }), // refund
    ])
    expect(result.income).toBe(1000)
    expect(result.expenses).toBe(150)
    expect(result.net).toBe(850)
  })

  it('refund in income category reduces income', () => {
    const result = computeKPIs([
      tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', amount: -30, schedule_c_category: 'payout' }), // chargeback
    ])
    expect(result.income).toBe(970)
    expect(result.expenses).toBe(0)
    expect(result.net).toBe(970)
  })

  it('treats cogs bucket as expense in KPI display', () => {
    const result = computeKPIs([
      tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', amount: -400, schedule_c_category: 'cost_of_goods' }),
    ])
    expect(result.income).toBe(1000)
    expect(result.expenses).toBe(400)
    expect(result.net).toBe(600)
  })
})

describe('computeMonthlyChart', () => {
  it('groups income/expense by yyyy-MM', () => {
    const result = computeMonthlyChart([
      tx({ id: 'a', date: '2026-01-15', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', date: '2026-01-20', amount: -200, schedule_c_category: 'supplies' }),
      tx({ id: 'c', date: '2026-02-05', amount: 500, schedule_c_category: 'payout' }),
    ])
    expect(result).toEqual([
      { month: '2026-01', income: 1000, expenses: 200 },
      { month: '2026-02', income: 500, expenses: 0 },
    ])
  })

  it('refund in expense category reduces expense bar, does not add to income bar (regression)', () => {
    const result = computeMonthlyChart([
      tx({ id: 'a', date: '2026-01-15', amount: -200, schedule_c_category: 'supplies' }),
      tx({ id: 'b', date: '2026-01-20', amount: 50, schedule_c_category: 'supplies' }),
    ])
    expect(result).toEqual([
      { month: '2026-01', income: 0, expenses: 150 },
    ])
  })

  it('sorts months ascending', () => {
    const result = computeMonthlyChart([
      tx({ id: 'a', date: '2026-03-10', amount: 100, schedule_c_category: 'payout' }),
      tx({ id: 'b', date: '2026-01-10', amount: 100, schedule_c_category: 'payout' }),
      tx({ id: 'c', date: '2026-02-10', amount: 100, schedule_c_category: 'payout' }),
    ])
    expect(result.map(r => r.month)).toEqual(['2026-01', '2026-02', '2026-03'])
  })
})
