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
