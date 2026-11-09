import { bucketTransaction } from './categories'
import type { CustomCategory } from './categories'
import type { Transaction } from './types'
import { monthKey } from './utils'
import type { SalesIncomeTotals } from './salesIncome'

/**
 * Sales-based income (2026-11-09): sales reach Schedule C through
 * `SalesIncomeTotals` (src/lib/salesIncome.ts), merged into the same built-in
 * category keys the transaction side uses, so every consumer (Breakdown, KPIs,
 * chart) shows one combined figure per line:
 *   payout             += grossReceipts     (Line 1)
 *   returns_allowances −= returns           (Line 2)
 *   commissions_fees   −= fees              (Line 10)
 *   shipping_postage   −= platformShipping  (Line 27a)
 * The sales argument is optional so callers without sales data (and the
 * pre-existing tests) behave exactly as before.
 */
function mergeSales(totals: Record<string, number>, s: SalesIncomeTotals) {
  const add = (k: string, v: number) => { if (v !== 0) totals[k] = (totals[k] ?? 0) + v }
  add('payout', s.grossReceipts)
  add('returns_allowances', -s.returns)
  add('commissions_fees', -s.fees)
  add('shipping_postage', -s.platformShipping)
}

/** Sum of signed amounts per Schedule C category. Sum is signed (refunds against expenses reduce expense totals). */
export function computeScheduleC(
  transactions: Transaction[],
  customs: CustomCategory[],
  sales?: SalesIncomeTotals,
): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === null || b.categoryValue === null) continue
    totals[b.categoryValue] = (totals[b.categoryValue] ?? 0) + b.signedAmount
  }
  if (sales) mergeSales(totals, sales)
  return totals
}

export interface KPITotals {
  income: number    // display value, always >= 0 in normal cases
  expenses: number  // display value, always >= 0 in normal cases
  net: number       // income - expenses
}

/**
 * Period-scoped income, expenses, and net for the dashboard KPI row. Refunds
 * against expenses reduce expenses. With sales: income += gross − returns,
 * expenses += fees + platform shipping.
 */
export function computeKPIs(
  transactions: Transaction[],
  customs: CustomCategory[],
  sales?: SalesIncomeTotals,
): KPITotals {
  let incomeSum = 0
  let expenseSum = 0  // negative in the normal case
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === 'income') incomeSum += b.signedAmount
    else if (b.bucket === 'expense' || b.bucket === 'cogs') expenseSum += b.signedAmount
  }
  if (sales) {
    incomeSum += sales.grossReceipts - sales.returns
    expenseSum -= sales.fees + sales.platformShipping
  }
  return {
    income: incomeSum,
    expenses: Math.abs(expenseSum),
    net: incomeSum + expenseSum, // expenseSum already negative
  }
}

export interface MonthlyBar {
  month: string   // 'yyyy-MM'
  income: number  // >= 0 display value
  expenses: number // >= 0 display value
}

/** Monthly income/expense bar chart data. Refunds against expenses reduce expenses, not income. */
export function computeMonthlyChart(
  transactions: Transaction[],
  customs: CustomCategory[],
  salesByMonth?: Record<string, SalesIncomeTotals>,
): MonthlyBar[] {
  const months: Record<string, { income: number; expense: number }> = {}
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === null) continue
    const key = monthKey(t.date)
    if (!months[key]) months[key] = { income: 0, expense: 0 }
    if (b.bucket === 'income') months[key].income += b.signedAmount
    else months[key].expense += b.signedAmount // negative in normal case
  }
  for (const [key, s] of Object.entries(salesByMonth ?? {})) {
    if (!months[key]) months[key] = { income: 0, expense: 0 }
    months[key].income += s.grossReceipts - s.returns
    months[key].expense -= s.fees + s.platformShipping
  }
  return Object.keys(months)
    .sort()
    .map(month => ({
      month,
      income: months[month].income,
      expenses: Math.abs(months[month].expense),
    }))
}
