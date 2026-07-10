import { describe, it, expect } from 'vitest'
import { scheduleCExportRows, buildScheduleCTransactionsCSV, SCHEDULE_C_EXPORT_HEADERS } from '../csvExport'
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

// Column indices for readability
const [DATE, TYPE, CATEGORY, LINE, MERCHANT, PLATFORM, GROSS, AMOUNT, NOTES] = [0, 1, 2, 3, 4, 5, 6, 7, 8]

describe('scheduleCExportRows', () => {
  it('exports abs() amount with direction in the Type column', () => {
    const [expense] = scheduleCExportRows([tx({ amount: -50 })], [])
    expect(expense[TYPE]).toBe('Expense')
    expect(expense[AMOUNT]).toBe('50.00')

    const [income] = scheduleCExportRows([tx({ amount: 200, schedule_c_category: 'payout' })], [])
    expect(income[TYPE]).toBe('Income')
    expect(income[AMOUNT]).toBe('200.00')
  })

  it('maps the category to its Schedule C line and label', () => {
    const [row] = scheduleCExportRows([tx({ schedule_c_category: 'office_expense' })], [])
    expect(row[CATEGORY]).toBe('Office Expense')
    expect(row[LINE]).toBe('Line 18')
  })

  it('excludes settlement record_type rows', () => {
    const rows = scheduleCExportRows([tx({ record_type: 'settlement' })], [])
    expect(rows).toHaveLength(0)
  })

  it('excludes Non-Business (isExcluded) categories', () => {
    const rows = scheduleCExportRows([
      tx({ schedule_c_category: 'transfer' }),
      tx({ schedule_c_category: 'personal' }),
    ], [])
    expect(rows).toHaveLength(0)
  })

  it('includes sale-linked rows (that is where sales income lives)', () => {
    const rows = scheduleCExportRows([
      tx({ amount: 100, schedule_c_category: 'payout', related_sale_id: 's1', platform: 'ebay' }),
    ], [])
    expect(rows).toHaveLength(1)
    expect(rows[0][PLATFORM]).toBe('ebay')
    expect(rows[0][TYPE]).toBe('Income')
  })

  it('includes uncategorized rows labeled Uncategorized with no line', () => {
    const [row] = scheduleCExportRows([tx({ schedule_c_category: undefined })], [])
    expect(row[CATEGORY]).toBe('Uncategorized')
    expect(row[LINE]).toBe('')
  })

  it('a refund categorized returns_allowances exports as Expense-direction under that category', () => {
    const [row] = scheduleCExportRows([tx({ amount: -30, schedule_c_category: 'returns_allowances' })], [])
    expect(row[TYPE]).toBe('Expense')
    expect(row[CATEGORY]).toBe('Returns & Allowances')
    expect(row[LINE]).toBe('Part I')
    expect(row[AMOUNT]).toBe('30.00')
  })

  it('does NOT apply the meals 50% multiplier (ledger shows the actual amount)', () => {
    const [row] = scheduleCExportRows([tx({ amount: -40, schedule_c_category: 'meals' })], [])
    expect(row[AMOUNT]).toBe('40.00')
  })

  it('prefers gross_amount for the Gross Amount column, falling back to abs(amount)', () => {
    const [withGross] = scheduleCExportRows([tx({ amount: -18, gross_amount: 20 })], [])
    expect(withGross[GROSS]).toBe('20.00')
    const [noGross] = scheduleCExportRows([tx({ amount: -18 })], [])
    expect(noGross[GROSS]).toBe('18.00')
  })

  it('sorts rows ascending by date', () => {
    const rows = scheduleCExportRows([
      tx({ id: 'b', date: '2026-03-01' }),
      tx({ id: 'a', date: '2026-01-01' }),
      tx({ id: 'c', date: '2026-02-01' }),
    ], [])
    expect(rows.map(r => r[DATE])).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
  })

  it('carries merchant and notes through', () => {
    const [row] = scheduleCExportRows([tx({ merchant: 'USPS', notes: 'label' })], [])
    expect(row[MERCHANT]).toBe('USPS')
    expect(row[NOTES]).toBe('label')
  })
})

describe('buildScheduleCTransactionsCSV', () => {
  it('emits the header row followed by CRLF-delimited data', () => {
    const csv = buildScheduleCTransactionsCSV([tx({ amount: -12, schedule_c_category: 'supplies' })], [])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(SCHEDULE_C_EXPORT_HEADERS.join(','))
    expect(lines[1]).toContain('Supplies')
    expect(lines[1]).toContain('12.00')
  })

  it('quotes cells containing commas', () => {
    const csv = buildScheduleCTransactionsCSV([tx({ merchant: 'Smith, Jones & Co' })], [])
    expect(csv).toContain('"Smith, Jones & Co"')
  })
})
