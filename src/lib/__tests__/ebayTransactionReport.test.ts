import { describe, it, expect } from 'vitest'
import {
  parseEbayTransactionReport, parseEbayAmount, parseEbayDate,
} from '../../../supabase/functions/_shared/ebayTransactionReport'

const HEADER = [
  'Transaction creation date', 'Type', 'Order number', 'Legacy order ID', 'Net amount', 'Payout ID', 'Item ID',
  'Transaction ID', 'Item title', 'Final Value Fee - fixed', 'Final Value Fee - variable', 'Regulatory operating fee',
  'Very high "item not as described" fee', 'Below standard performance fee', 'International fee', 'Charity donation',
  'Deposit processing fee', 'Gross transaction amount', 'Reference ID', 'Description',
]
const row = (o: Record<string, string>) => HEADER.map(h => o[h] ?? '--')
const parse = (...rows: Record<string, string>[]) => parseEbayTransactionReport(HEADER, rows.map(row))
const sum = (xs: { amount: number }[]) => Math.round(xs.reduce((t, x) => t + x.amount, 0) * 100) / 100

describe('parseEbayTransactionReport', () => {
  it('books every order fee column, so an order\'s rows sum to its Net amount', () => {
    const { rows } = parse({
      'Transaction creation date': 'Oct 4, 2026', Type: 'Order', 'Order number': '11-11111-11111', 'Transaction ID': '123',
      'Gross transaction amount': '500.00', 'Final Value Fee - fixed': '-0.40', 'Final Value Fee - variable': '-65.00',
      'Below standard performance fee': '-30.00', 'Net amount': '404.60', 'Payout ID': 'P1',
    })
    expect(rows.map(r => r.csv_transaction_id)).toEqual(['ebay_123_order', 'ebay_123_fvf', 'ebay_123_ofee'])
    expect(rows[2]).toMatchObject({ amount: -30, schedule_c_category: 'commissions_fees', notes: '11-11111-11111' })
    expect(sum(rows)).toBe(404.6)
  })

  it('keys Transaction ID "0" rows by order + item instead of collapsing them (2025 bug: 102 orders lost)', () => {
    const { rows } = parse(
      { 'Transaction creation date': 'Jul 1, 2025', Type: 'Order', 'Order number': 'A', 'Item ID': '111', 'Transaction ID': '0', 'Gross transaction amount': '40', 'Final Value Fee - variable': '-6', 'Net amount': '34' },
      { 'Transaction creation date': 'Jul 2, 2025', Type: 'Order', 'Order number': 'B', 'Item ID': '222', 'Transaction ID': '0', 'Gross transaction amount': '20', 'Final Value Fee - variable': '-3', 'Net amount': '17' },
    )
    const ids = rows.map(r => r.csv_transaction_id)
    expect(ids).toEqual(['ebay_A_111_order', 'ebay_A_111_fvf', 'ebay_B_222_order', 'ebay_B_222_fvf'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the old keys where they never collided (re-import must not duplicate)', () => {
    const { rows } = parse(
      { 'Transaction creation date': 'Jul 1, 2025', Type: 'Order', 'Order number': 'H', 'Transaction ID': '--', 'Gross transaction amount': '21.74', 'Net amount': '18.40' },
      { 'Transaction creation date': 'Jul 1, 2025', Type: 'Other fee', 'Order number': 'H', 'Reference ID': 'FEE-1', 'Net amount': '-2.10', Description: 'Promoted Listings - General fee' },
      { 'Transaction creation date': 'Jul 3, 2025', Type: 'Refund', 'Order number': 'H', 'Reference ID': 'Return ID 99', 'Net amount': '-5' },
      { 'Transaction creation date': 'Jul 9, 2025', Type: 'Payout', 'Payout ID': '777', 'Net amount': '-100' },
    )
    expect(rows.map(r => r.csv_transaction_id)).toEqual(['ebay_H_order', 'ebay_FEE-1_fee', 'ebay_Return_ID_99_refund', 'ebay_payout_777'])
    expect(rows[1].schedule_c_category).toBe('advertising')
  })

  it('a label and its "Underpaid" adjustment on the same tracking number both survive', () => {
    const { rows } = parse(
      { 'Transaction creation date': 'Oct 6, 2025', Type: 'Shipping label', 'Order number': 'O', 'Reference ID': 'Tracking no. 1Z', 'Net amount': '-20.00', Description: 'UPS' },
      { 'Transaction creation date': 'Oct 22, 2025', Type: 'Shipping label', 'Order number': 'O', 'Reference ID': 'Tracking no. 1Z', 'Net amount': '-10.00', Description: 'Underpaid, UPS' },
    )
    expect(rows.map(r => r.csv_transaction_id)).toEqual(['ebay_Tracking no. 1Z_2025-10-06_-2000_ship', 'ebay_Tracking no. 1Z_2025-10-22_-1000_ship'])
    expect(sum(rows)).toBe(-30)
  })

  it('exact repeats get _dup2 instead of being dropped; same-day charges without a reference are kept apart by amount', () => {
    const c = { 'Transaction creation date': 'Oct 27, 2025', Type: 'Charge', 'Net amount': '10.00' }
    const { rows } = parse(c, c, { ...c, 'Net amount': '20.00' })
    expect(rows.map(r => r.csv_transaction_id)).toEqual([
      'ebay_2025-10-27_charge_2025-10-27_1000_charge',
      'ebay_2025-10-27_charge_2025-10-27_1000_dup2_charge',
      'ebay_2025-10-27_charge_2025-10-27_2000_charge',
    ])
  })

  it('books "eBay funds purchase" rows instead of skipping them; still skips transfers and reports unknown types', () => {
    const { rows, skipped } = parse(
      { 'Transaction creation date': 'May 15, 2026', Type: 'Purchase', 'Transaction ID': 'T9', 'Item title': 'Elite Trainer Box', 'Net amount': '-100.00', Description: 'eBay funds purchase' },
      { 'Transaction creation date': 'May 16, 2026', Type: 'Transfer', 'Net amount': '5' },
      { 'Transaction creation date': 'May 17, 2026', Type: 'Mystery', 'Net amount': '1' },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ csv_transaction_id: 'ebay_T9_2026-05-15_-10000_purchase', amount: -100, schedule_c_category: 'cost_of_goods' })
    expect(skipped).toEqual({ 'intentional:Transfer': 1, 'ebay_type:Mystery': 1 })
  })

  it('parses eBay amounts and dates', () => {
    expect([parseEbayAmount('"1,040"'), parseEbayAmount('(12.50)'), parseEbayAmount('--'), parseEbayAmount('$-3.10')]).toEqual([1040, -12.5, 0, -3.1])
    expect([parseEbayDate('Nov 9, 2026'), parseEbayDate('2026-01-05'), parseEbayDate('1/5/2026'), parseEbayDate('--')]).toEqual(['2026-11-09', '2026-01-05', '2026-01-05', null])
  })
})
