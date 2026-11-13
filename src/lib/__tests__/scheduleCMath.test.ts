import { describe, it, expect } from 'vitest'
import { computeScheduleC, computeKPIs, computeMonthlyChart } from '../scheduleCMath'
import type { Transaction } from '../types'
import type { SalesIncomeTotals } from '../salesIncome'

const SALES: SalesIncomeTotals = { grossReceipts: 1000, returns: 100, fees: 130, platformShipping: 40, saleCount: 3 }

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', user_id: 'u1', date: '2026-01-15', amount: -50,
    source: 'manual', record_type: 'transaction',
    schedule_c_category: 'supplies',
    created_at: '2026-01-15T00:00:00Z',
    is_non_cash: false,
    ...overrides,
  }
}

describe('computeScheduleC', () => {
  it('sums signed amounts per category', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: 'supplies' }),
      tx({ id: 'b', amount: -50, schedule_c_category: 'supplies' }),
      tx({ id: 'c', amount: -200, schedule_c_category: 'advertising' }),
    ], [])
    expect(totals).toEqual({ supplies: -150, advertising: -200 })
  })

  it('refund posted to expense category reduces the category total (regression)', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: 'supplies' }),
      tx({ id: 'b', amount: 30, schedule_c_category: 'supplies' }), // refund
    ], [])
    expect(totals).toEqual({ supplies: -70 })
  })

  it('applies meals 50%', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: 'meals' }),
    ], [])
    expect(totals).toEqual({ meals: -50 })
  })

  it('excludes settlements, csv_import, related_sale_id, net_zero pairs', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: 'supplies' }),
      tx({ id: 'b', amount: -50, schedule_c_category: 'supplies', record_type: 'settlement' }),
      tx({ id: 'c', amount: -50, schedule_c_category: 'supplies', source: 'csv_import' }),
      tx({ id: 'd', amount: -50, schedule_c_category: 'supplies', related_sale_id: 's1' }),
      tx({ id: 'e', amount: -50, schedule_c_category: 'supplies', net_zero_pair_id: 'p1' }),
    ], [])
    expect(totals).toEqual({ supplies: -100 })
  })

  it('excludes isExcluded categories', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -500, schedule_c_category: 'transfer' }),
      tx({ id: 'b', amount: -100, schedule_c_category: 'personal' }),
      tx({ id: 'c', amount: -50, schedule_c_category: 'supplies' }),
    ], [])
    expect(totals).toEqual({ supplies: -50 })
  })

  it('excludes uncategorized', () => {
    const totals = computeScheduleC([
      tx({ id: 'a', amount: -100, schedule_c_category: undefined }),
    ], [])
    expect(totals).toEqual({})
  })
})

describe('computeKPIs', () => {
  it('sums income and expenses with signed amounts', () => {
    const result = computeKPIs([
      tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', amount: -200, schedule_c_category: 'supplies' }),
      tx({ id: 'c', amount: -100, schedule_c_category: 'advertising' }),
    ], [])
    expect(result.income).toBe(1000)
    expect(result.expenses).toBe(300)
    expect(result.net).toBe(700)
  })

  it('refund in expense category reduces expenses, does not inflate income (regression)', () => {
    const result = computeKPIs([
      tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', amount: -200, schedule_c_category: 'supplies' }),
      tx({ id: 'c', amount: 50, schedule_c_category: 'supplies' }), // refund
    ], [])
    expect(result.income).toBe(1000)
    expect(result.expenses).toBe(150)
    expect(result.net).toBe(850)
  })

  it('refund in income category reduces income', () => {
    const result = computeKPIs([
      tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', amount: -30, schedule_c_category: 'payout' }), // chargeback
    ], [])
    expect(result.income).toBe(970)
    expect(result.expenses).toBe(0)
    expect(result.net).toBe(970)
  })

  it('keeps inventory purchases out of expenses: they become cost of goods sold', () => {
    const result = computeKPIs([
      tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', amount: -400, schedule_c_category: 'cost_of_goods' }),
    ], [])
    expect(result.income).toBe(1000)
    expect(result.expenses).toBe(0)
    expect(result.cogs).toBe(400) // no inventory change supplied → cogs = purchases
    expect(result.net).toBe(600)
  })

  it('reports inventory purchases and adds the inventory change to an inventory-basis net', () => {
    const txs = [
      tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', amount: -400, schedule_c_category: 'cost_of_goods' }),
      tx({ id: 'c', amount: -100, schedule_c_category: 'supplies' }),
    ]
    const r = computeKPIs(txs, [], undefined, 250) // 250 of the 400 bought is still on the shelf
    // expenses 100 (opex only); cogs = 400 − 250 = 150; net = 1000 − 100 − 150
    expect([r.expenses, r.inventoryPurchases, r.cogs, r.net, r.cashNet]).toEqual([100, 400, 150, 750, 500])
    // Without an inventory change, both nets agree.
    const plain = computeKPIs(txs, [])
    expect([plain.inventoryChange, plain.net]).toEqual([0, plain.cashNet])
  })

  it('a falling inventory lowers the inventory-basis net (old stock sold this period)', () => {
    const r = computeKPIs([tx({ id: 'a', amount: 1000, schedule_c_category: 'payout' })], [], undefined, -300)
    expect([r.cogs, r.net]).toEqual([300, 700]) // old stock sold: cogs with no purchases
  })
})

describe('computeMonthlyChart', () => {
  it('groups income/expense by yyyy-MM', () => {
    const result = computeMonthlyChart([
      tx({ id: 'a', date: '2026-01-15', amount: 1000, schedule_c_category: 'payout' }),
      tx({ id: 'b', date: '2026-01-20', amount: -200, schedule_c_category: 'supplies' }),
      tx({ id: 'c', date: '2026-02-05', amount: 500, schedule_c_category: 'payout' }),
    ], [])
    expect(result).toEqual([
      { month: '2026-01', income: 1000, expenses: 200, cogs: 0 },
      { month: '2026-02', income: 500, expenses: 0, cogs: 0 },
    ])
  })

  it('refund in expense category reduces expense bar, does not add to income bar (regression)', () => {
    const result = computeMonthlyChart([
      tx({ id: 'a', date: '2026-01-15', amount: -200, schedule_c_category: 'supplies' }),
      tx({ id: 'b', date: '2026-01-20', amount: 50, schedule_c_category: 'supplies' }),
    ], [])
    expect(result).toEqual([
      { month: '2026-01', income: 0, expenses: 150, cogs: 0 },
    ])
  })

  it('sorts months ascending', () => {
    const result = computeMonthlyChart([
      tx({ id: 'a', date: '2026-03-10', amount: 100, schedule_c_category: 'payout' }),
      tx({ id: 'b', date: '2026-01-10', amount: 100, schedule_c_category: 'payout' }),
      tx({ id: 'c', date: '2026-02-10', amount: 100, schedule_c_category: 'payout' }),
    ], [])
    expect(result.map(r => r.month)).toEqual(['2026-01', '2026-02', '2026-03'])
  })
})

describe('sales-based income (2026-11-09)', () => {
  it('computeScheduleC merges sales into payout / returns / fees / shipping', () => {
    const r = computeScheduleC([tx({ amount: -10, schedule_c_category: 'shipping_postage' })], [], SALES)
    expect(r.payout).toBe(1000)
    expect(r.returns_allowances).toBe(-100)
    expect(r.commissions_fees).toBe(-130)
    expect(r.shipping_postage).toBe(-50)
  })

  it('computeScheduleC without sales is unchanged', () => {
    expect(computeScheduleC([tx()], [])).toEqual({ supplies: -50 })
  })

  it('computeKPIs: income = gross − returns, expenses += fees + platform shipping', () => {
    const k = computeKPIs([tx({ amount: -50 })], [], SALES)
    expect(k.income).toBe(900)
    expect(k.expenses).toBe(220)
    expect(k.net).toBe(680)
  })

  it('computeMonthlyChart adds sales by month, including months with no transactions', () => {
    const bars = computeMonthlyChart([tx({ date: '2026-01-10', amount: -50 })], [], { '2026-02': SALES })
    expect(bars).toEqual([
      { month: '2026-01', income: 0, expenses: 50, cogs: 0 },
      { month: '2026-02', income: 900, expenses: 170, cogs: 0 },
    ])
  })
})

describe('Total Income KPI matches Schedule C Part I (P0 regression)', () => {
  it('KPI income = Line 1 − Line 2 from the breakdown, with sales, unlinked payouts, settlements and sale-derived rows mixed', () => {
    const txs = [
      tx({ id: 'p', amount: 400, schedule_c_category: 'payout' }),                       // unlinked deposit still tagged income
      tx({ id: 'cb', amount: -25, schedule_c_category: 'payout' }),                      // chargeback
      tx({ id: 'st', amount: 900, schedule_c_category: 'settlement', record_type: 'settlement' }), // never income
      tx({ id: 'sd', amount: 300, schedule_c_category: 'payout', related_sale_id: 's1' }), // sale-derived → counted via SALES
      tx({ id: 'ex', amount: -60, schedule_c_category: 'supplies' }),
    ]
    const k = computeKPIs(txs, [], SALES)
    const sc = computeScheduleC(txs, [], SALES)
    const partI = (sc.payout ?? 0) + (sc.returns_allowances ?? 0)
    expect(k.income).toBe(partI)
    expect(k.income).toBe(400 - 25 + SALES.grossReceipts - SALES.returns) // 1275, computed a second way
  })
})

describe('computeMonthlyChart with inventory', () => {
  it('splits purchases out of expenses into per-month cost of goods sold', () => {
    const bars = computeMonthlyChart([
      tx({ id: 'a', date: '2026-01-10', amount: -400, schedule_c_category: 'cost_of_goods' }),
      tx({ id: 'b', date: '2026-01-12', amount: -100, schedule_c_category: 'supplies' }),
    ], [], undefined, { '2026-01': 250, '2026-02': -150 })
    // Jan: bought 400, 250 still on the shelf → cogs 150. Feb: no purchases, 150 of stock sold → cogs 150.
    expect(bars).toEqual([
      { month: '2026-01', income: 0, expenses: 100, cogs: 150 },
      { month: '2026-02', income: 0, expenses: 0, cogs: 150 },
    ])
  })
})
