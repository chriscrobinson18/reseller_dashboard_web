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
  /** Operating expenses only — inventory purchases are NOT here (see cogs). */
  expenses: number
  /** Inventory purchases (cost_of_goods bucket) in the period, positive magnitude. */
  inventoryPurchases: number
  /** ending − beginning inventory for the period; 0 when not supplied. */
  inventoryChange: number
  /** Cost of goods SOLD = purchases − inventory change (= beginning + purchases − ending). */
  cogs: number
  /** income − cogs − expenses: unsold inventory is an asset, not a cost. */
  net: number
  /** income − expenses − purchases: every inventory purchase treated as a cost (old Net). */
  cashNet: number
}

/**
 * Period-scoped KPI row. Refunds against expenses reduce expenses. With sales:
 * income += gross − returns, expenses += fees + platform shipping.
 *
 * Inventory purchases are kept out of `expenses` and become `cogs` once
 * adjusted by `inventoryChange` (inventoryChangeForPeriod in partIII.ts):
 * stock still on the shelf at the end of the period isn't a cost of it.
 */
export function computeKPIs(
  transactions: Transaction[],
  customs: CustomCategory[],
  sales?: SalesIncomeTotals,
  inventoryChange = 0,
): KPITotals {
  let incomeSum = 0
  let expenseSum = 0  // negative in the normal case
  let cogsSum = 0     // negative in the normal case
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === 'income') incomeSum += b.signedAmount
    else if (b.bucket === 'expense') expenseSum += b.signedAmount
    else if (b.bucket === 'cogs') cogsSum += b.signedAmount
  }
  if (sales) {
    incomeSum += sales.grossReceipts - sales.returns
    expenseSum -= sales.fees + sales.platformShipping
  }
  const expenses = Math.abs(expenseSum)
  const inventoryPurchases = 0 - cogsSum // 0 - x avoids -0 when nothing was bought
  const cogs = inventoryPurchases - inventoryChange
  return {
    income: incomeSum,
    expenses,
    inventoryPurchases,
    inventoryChange,
    cogs,
    net: incomeSum - expenses - cogs,
    cashNet: incomeSum - expenses - inventoryPurchases,
  }
}

export interface MonthlyBar {
  month: string   // 'yyyy-MM'
  income: number  // >= 0 display value
  /** Operating expenses only (inventory purchases excluded). */
  expenses: number
  /** Cost of goods sold: purchases − that month's inventory change. */
  cogs: number
}

/**
 * Monthly income / operating expenses / cost of goods sold. Refunds against
 * expenses reduce expenses, not income. `inventoryChangeByMonth` (partIII.ts)
 * turns each month's inventory purchases into cost of goods sold; without it
 * cogs falls back to purchases. Months present only in the inventory map are
 * included so the monthly cogs always sum to the period's.
 */
export function computeMonthlyChart(
  transactions: Transaction[],
  customs: CustomCategory[],
  salesByMonth?: Record<string, SalesIncomeTotals>,
  inventoryChangeByMonth?: Record<string, number>,
): MonthlyBar[] {
  const months: Record<string, { income: number; expense: number; purchases: number }> = {}
  const at = (key: string) => (months[key] ??= { income: 0, expense: 0, purchases: 0 })
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === null) continue
    const m = at(monthKey(t.date))
    if (b.bucket === 'income') m.income += b.signedAmount
    else if (b.bucket === 'cogs') m.purchases -= b.signedAmount // positive magnitude
    else m.expense += b.signedAmount // negative in normal case
  }
  for (const [key, s] of Object.entries(salesByMonth ?? {})) {
    const m = at(key)
    m.income += s.grossReceipts - s.returns
    m.expense -= s.fees + s.platformShipping
  }
  for (const key of Object.keys(inventoryChangeByMonth ?? {})) at(key)
  return Object.keys(months)
    .sort()
    .map(month => ({
      month,
      income: months[month].income,
      expenses: Math.abs(months[month].expense),
      cogs: months[month].purchases - (inventoryChangeByMonth?.[month] ?? 0) + 0, // + 0 normalises -0
    }))
}
