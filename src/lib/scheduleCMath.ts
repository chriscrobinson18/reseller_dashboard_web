import { bucketTransaction } from './categories'
import type { CustomCategory } from './categories'
import type { Transaction } from './types'
import { monthKey } from './utils'

/** Sum of signed amounts per Schedule C category. Sum is signed (refunds against expenses reduce expense totals). */
export function computeScheduleC(transactions: Transaction[], customs: CustomCategory[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === null || b.categoryValue === null) continue
    totals[b.categoryValue] = (totals[b.categoryValue] ?? 0) + b.signedAmount
  }
  return totals
}

export interface KPITotals {
  income: number    // display value, always >= 0 in normal cases
  expenses: number  // display value, always >= 0 in normal cases
  net: number       // income - expenses
}

/** Period-scoped income, expenses, and net for the dashboard KPI row. Refunds against expenses reduce expenses. */
export function computeKPIs(transactions: Transaction[], customs: CustomCategory[]): KPITotals {
  let incomeSum = 0
  let expenseSum = 0  // negative in the normal case
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === 'income') incomeSum += b.signedAmount
    else if (b.bucket === 'expense' || b.bucket === 'cogs') expenseSum += b.signedAmount
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
export function computeMonthlyChart(transactions: Transaction[], customs: CustomCategory[]): MonthlyBar[] {
  const months: Record<string, { income: number; expense: number }> = {}
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === null) continue
    const key = monthKey(t.date)
    if (!months[key]) months[key] = { income: 0, expense: 0 }
    if (b.bucket === 'income') months[key].income += b.signedAmount
    else months[key].expense += b.signedAmount // negative in normal case
  }
  return Object.keys(months)
    .sort()
    .map(month => ({
      month,
      income: months[month].income,
      expenses: Math.abs(months[month].expense),
    }))
}
