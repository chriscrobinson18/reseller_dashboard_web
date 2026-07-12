import type { Transaction } from './types'
import { resolveCategory, type CustomCategory } from './categories'

// ─── Generic CSV helpers ──────────────────────────────────────────────────────

/** Escapes a single CSV cell per RFC 4180 (quote if it contains a comma, quote,
 *  or newline; double any embedded quotes). */
function csvCell(value: string | number): string {
  const s = String(value ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Joins a header row + data rows into a CRLF-delimited CSV string. */
export function toCSV(headers: string[], rows: (string | number)[][]): string {
  return [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')
}

/** Triggers a browser download of `content` as `filename`. */
export function downloadCSV(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Schedule C transaction export ─────────────────────────────────────────────

export const SCHEDULE_C_EXPORT_HEADERS = [
  'Date', 'Type', 'Category', 'Schedule C Line', 'Merchant', 'Platform', 'Gross Amount', 'Amount', 'Notes',
]

/**
 * Builds the row set for the per-period Schedule C transaction export.
 *
 * Scope: **all business rows** for the period — every transaction EXCEPT
 *   - `record_type === 'settlement'` (disbursement rows, not P&L lines), and
 *   - rows whose resolved category is `isExcluded` (Transfer / Personal /
 *     Settlement / Balance Adjustment, plus customs inheriting that flag).
 * Sale-linked (`related_sale_id` / `csv_import`) rows ARE included — that is
 * where sales income and selling costs live — as are uncategorized rows, which
 * are labeled `Uncategorized` so nothing is silently dropped from the ledger.
 *
 * Sign convention: `Amount` is always the absolute value; the `Type` column
 * (`Income` / `Expense`) carries the direction that abs() removed. A refund
 * (negative amount categorized `returns_allowances`) therefore exports as an
 * `Expense`-direction row under the Returns & Allowances category — faithful to
 * the cash direction. The meals 50% multiplier is NOT applied here: a ledger
 * shows the actual dollar amount; the half-deduction is a form-summary concern.
 *
 * Rows are sorted ascending by date.
 */
export function scheduleCExportRows(
  transactions: Transaction[],
  customs: CustomCategory[],
): (string | number)[][] {
  return transactions
    .filter(t => {
      if (t.record_type === 'settlement') return false
      const cat = resolveCategory(t.schedule_c_category, customs)
      return !cat?.isExcluded
    })
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(t => {
      const cat = resolveCategory(t.schedule_c_category, customs)
      const abs = Math.abs(t.amount)
      return [
        t.date,
        t.amount >= 0 ? 'Income' : 'Expense',
        cat?.label ?? 'Uncategorized',
        cat?.scheduleLine ?? '',
        t.merchant ?? '',
        t.platform ?? '',
        (t.gross_amount ?? abs).toFixed(2),
        abs.toFixed(2),
        t.notes ?? '',
      ]
    })
}

/** Full CSV string for the Schedule C transaction export. */
export function buildScheduleCTransactionsCSV(
  transactions: Transaction[],
  customs: CustomCategory[],
): string {
  return toCSV(SCHEDULE_C_EXPORT_HEADERS, scheduleCExportRows(transactions, customs))
}

// ─── Schedule C summary ("form" view) ──────────────────────────────────────────

/** Part II expense lines in IRS Schedule C order, with form descriptions.
 *  Line 30 (home office) is handled separately — it is NOT part of Line 28. */
const PART_II_LINES: Array<{ line: string; label: string }> = [
  { line: 'Line 8', label: 'Advertising' },
  { line: 'Line 9', label: 'Car and truck expenses' },
  { line: 'Line 10', label: 'Commissions and fees' },
  { line: 'Line 11', label: 'Contract labor' },
  { line: 'Line 13', label: 'Depreciation' },
  { line: 'Line 15', label: 'Insurance (other than health)' },
  { line: 'Line 16', label: 'Interest' },
  { line: 'Line 17', label: 'Legal and professional services' },
  { line: 'Line 18', label: 'Office expense' },
  { line: 'Line 20b', label: 'Rent or lease — other business property' },
  { line: 'Line 21', label: 'Repairs and maintenance' },
  { line: 'Line 22', label: 'Supplies' },
  { line: 'Line 23', label: 'Taxes and licenses' },
  { line: 'Line 24a', label: 'Travel' },
  { line: 'Line 24b', label: 'Deductible meals' },
  { line: 'Line 25', label: 'Utilities' },
  { line: 'Line 27a', label: 'Other expenses' },
]

export interface ScheduleCSummary {
  grossReceipts: number     // Line 1 — Part I income excluding returns_allowances
  returns: number           // Line 2 — returns & allowances (positive magnitude)
  netReceipts: number       // Line 3 = Line 1 − Line 2
  cogs: number              // Line 4 — Part III (cost_of_goods transactions)
  grossProfit: number       // Line 5 = Line 3 − Line 4
  grossIncome: number       // Line 7 (no other-income modeled, = Line 5)
  expensesByLine: Record<string, number>  // Part II line → positive magnitude (nonzero only)
  totalExpenses: number     // Line 28
  tentativeProfit: number   // Line 29 = Line 7 − Line 28
  homeOffice: number        // Line 30
  netProfit: number         // Line 31 = Line 29 − Line 30
  uncategorizedNet: number  // informational — NOT included in netProfit
  uncategorizedCount: number
}

/**
 * Rolls the same all-business-row transaction set as the CSV transaction export
 * up into IRS Schedule C form lines (so the two exports tie out — the one
 * exception is Line 24b, where the form shows the 50%-deductible meals amount
 * while the transaction ledger shows the actual dollar amount).
 *
 * Sourcing note (chosen model): COGS (Line 4) is the sum of `cost_of_goods`
 * transactions — i.e. inventory PURCHASES in the period (a cash-basis
 * treatment), NOT the FIFO cost of items sold. Returns are placed on Line 2
 * (never netted into Line 1). Uncategorized business rows can't be placed on a
 * form line, so they are summed into `uncategorizedNet` and reported separately
 * rather than silently dropped.
 */
export function computeScheduleCSummary(
  transactions: Transaction[],
  customs: CustomCategory[],
): ScheduleCSummary {
  const perLine: Record<string, number> = {}  // signed sums keyed by scheduleLine
  let returnsSigned = 0
  let uncategorizedNet = 0
  let uncategorizedCount = 0

  for (const t of transactions) {
    if (t.record_type === 'settlement') continue
    const cat = resolveCategory(t.schedule_c_category, customs)
    if (cat?.isExcluded) continue
    if (!cat?.scheduleLine) {
      uncategorizedNet += t.amount
      uncategorizedCount += 1
      continue
    }
    const signed = t.amount * (cat.mealsHalf ? 0.5 : 1)
    if (t.schedule_c_category === 'returns_allowances') {
      returnsSigned += signed
      continue
    }
    perLine[cat.scheduleLine] = (perLine[cat.scheduleLine] ?? 0) + signed
  }

  const grossReceipts = perLine['Part I'] ?? 0
  const returns = Math.abs(returnsSigned)
  const netReceipts = grossReceipts - returns
  const cogs = Math.abs(perLine['Part III'] ?? 0)
  const grossProfit = netReceipts - cogs
  const grossIncome = grossProfit

  const expensesByLine: Record<string, number> = {}
  let totalExpenses = 0
  for (const { line } of PART_II_LINES) {
    const amt = Math.abs(perLine[line] ?? 0)
    if (amt !== 0) {
      expensesByLine[line] = amt
      totalExpenses += amt
    }
  }

  const tentativeProfit = grossIncome - totalExpenses
  const homeOffice = Math.abs(perLine['Line 30'] ?? 0)
  const netProfit = tentativeProfit - homeOffice

  return {
    grossReceipts, returns, netReceipts, cogs, grossProfit, grossIncome,
    expensesByLine, totalExpenses, tentativeProfit, homeOffice, netProfit,
    uncategorizedNet, uncategorizedCount,
  }
}

/**
 * Builds the Schedule C Summary CSV — one row per IRS line with net profit at
 * the bottom, preceded by a short metadata header (period + basis note).
 */
export function buildScheduleCSummaryCSV(
  transactions: Transaction[],
  customs: CustomCategory[],
  periodLabel: string,
): string {
  const s = computeScheduleCSummary(transactions, customs)
  const money = (n: number) => n.toFixed(2)

  const rows: (string | number)[][] = [
    ['1', 'Gross receipts', money(s.grossReceipts)],
    ['2', 'Returns and allowances', money(s.returns)],
    ['3', 'Net receipts (Line 1 − Line 2)', money(s.netReceipts)],
    ['4', 'Cost of goods sold', money(s.cogs)],
    ['5', 'Gross profit (Line 3 − Line 4)', money(s.grossProfit)],
    ['7', 'Gross income', money(s.grossIncome)],
  ]
  for (const { line, label } of PART_II_LINES) {
    if (s.expensesByLine[line] !== undefined) {
      rows.push([line, label, money(s.expensesByLine[line])])
    }
  }
  rows.push(['28', 'Total expenses', money(s.totalExpenses)])
  rows.push(['29', 'Tentative profit (Line 7 − Line 28)', money(s.tentativeProfit)])
  rows.push(['30', 'Expenses for business use of home', money(s.homeOffice)])
  rows.push(['31', 'Net profit or (loss)', money(s.netProfit)])
  if (s.uncategorizedCount > 0) {
    rows.push(['—', `Uncategorized — NOT included above (${s.uncategorizedCount} txns)`, money(s.uncategorizedNet)])
  }

  const header = [
    ['Schedule C Summary'],
    ['Period', periodLabel],
    ['Basis', 'Cash — COGS (Line 4) is inventory purchases in the period, not FIFO cost of items sold'],
    [],
    ['Line', 'Description', 'Amount'],
  ]
  return [...header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')
}
