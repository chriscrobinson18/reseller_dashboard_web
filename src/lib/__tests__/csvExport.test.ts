import { describe, it, expect } from 'vitest'
import {
  scheduleCExportRows, buildScheduleCTransactionsCSV, SCHEDULE_C_EXPORT_HEADERS,
  computeScheduleCSummary, buildScheduleCSummaryCSV,
} from '../csvExport'
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

describe('computeScheduleCSummary', () => {
  it('puts returns on Line 2 (never netted into Line 1 gross receipts)', () => {
    const s = computeScheduleCSummary([
      tx({ amount: 1000, schedule_c_category: 'payout', related_sale_id: 's1' }),
      tx({ amount: -150, schedule_c_category: 'returns_allowances', related_sale_id: 's1' }),
    ], [])
    expect(s.grossReceipts).toBe(1000)
    expect(s.returns).toBe(150)
    expect(s.netReceipts).toBe(850)
  })

  it('includes sale-linked income in gross receipts', () => {
    const s = computeScheduleCSummary([
      tx({ amount: 500, schedule_c_category: 'payout', related_sale_id: 's1' }),
      tx({ amount: 200, schedule_c_category: 'payout' }),
    ], [])
    expect(s.grossReceipts).toBe(700)
  })

  it('takes COGS from cost_of_goods transactions (purchases), as a positive magnitude', () => {
    const s = computeScheduleCSummary([tx({ amount: -300, schedule_c_category: 'cost_of_goods' })], [])
    expect(s.cogs).toBe(300)
  })

  it('applies the 50% deduction to meals on Line 24b', () => {
    const s = computeScheduleCSummary([tx({ amount: -80, schedule_c_category: 'meals' })], [])
    expect(s.expensesByLine['Line 24b']).toBe(40)
    expect(s.totalExpenses).toBe(40)
  })

  it('aggregates shipping_postage and other_expense into Line 27a', () => {
    const s = computeScheduleCSummary([
      tx({ amount: -10, schedule_c_category: 'shipping_postage' }),
      tx({ amount: -5, schedule_c_category: 'other_expense' }),
    ], [])
    expect(s.expensesByLine['Line 27a']).toBe(15)
  })

  it('computes the full profit chain incl. home office on Line 30', () => {
    const s = computeScheduleCSummary([
      tx({ amount: 1000, schedule_c_category: 'payout' }),
      tx({ amount: -100, schedule_c_category: 'returns_allowances' }),
      tx({ amount: -300, schedule_c_category: 'cost_of_goods' }),
      tx({ amount: -50, schedule_c_category: 'advertising' }),
      tx({ amount: -200, schedule_c_category: 'home_office' }),
    ], [])
    expect(s.netReceipts).toBe(900)   // 1000 - 100
    expect(s.grossProfit).toBe(600)   // 900 - 300
    expect(s.grossIncome).toBe(600)
    expect(s.totalExpenses).toBe(50)  // advertising only; home office is separate
    expect(s.tentativeProfit).toBe(550)
    expect(s.homeOffice).toBe(200)
    expect(s.netProfit).toBe(350)     // 550 - 200
  })

  it('a refund against an expense category reduces that line (signed sum before abs)', () => {
    const s = computeScheduleCSummary([
      tx({ amount: -100, schedule_c_category: 'supplies' }),
      tx({ amount: 30, schedule_c_category: 'supplies' }), // refund
    ], [])
    expect(s.expensesByLine['Line 22']).toBe(70)
  })

  it('excludes settlement and Non-Business rows', () => {
    const s = computeScheduleCSummary([
      tx({ amount: 500, schedule_c_category: 'payout', record_type: 'settlement' }),
      tx({ amount: -40, schedule_c_category: 'personal' }),
      tx({ amount: -25, schedule_c_category: 'transfer' }),
    ], [])
    expect(s.grossReceipts).toBe(0)
    expect(s.totalExpenses).toBe(0)
    expect(s.netProfit).toBe(0)
  })

  it('reports uncategorized business rows separately, not in net profit', () => {
    const s = computeScheduleCSummary([
      tx({ amount: 1000, schedule_c_category: 'payout' }),
      tx({ amount: -60, schedule_c_category: undefined }),
    ], [])
    expect(s.netProfit).toBe(1000)
    expect(s.uncategorizedCount).toBe(1)
    expect(s.uncategorizedNet).toBe(-60)
  })
})

describe('buildScheduleCSummaryCSV', () => {
  it('emits a period/basis header and the Line/Description/Amount table with net profit', () => {
    const csv = buildScheduleCSummaryCSV([
      tx({ amount: 1000, schedule_c_category: 'payout' }),
      tx({ amount: -50, schedule_c_category: 'advertising' }),
    ], [], 'Year to Date')
    expect(csv).toContain('Schedule C Summary')
    expect(csv).toContain('Period,Year to Date')
    expect(csv).toContain('1,Gross receipts,1000.00')
    expect(csv).toContain('Line 8,Advertising,50.00')
    expect(csv).toContain('31,Net profit or (loss),950.00')
  })

  it('omits Part II lines with no activity', () => {
    const csv = buildScheduleCSummaryCSV([tx({ amount: -50, schedule_c_category: 'advertising' })], [], 'YTD')
    expect(csv).toContain('Line 8,Advertising')
    expect(csv).not.toContain('Line 22,Supplies')
  })
})
