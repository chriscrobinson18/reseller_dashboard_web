// Pure parser for the eBay Transaction Report (Seller Hub → Payments → Reports
// → Transaction report), used by import_marketplace_csv (platform 'ebay').
// No Deno or npm imports, so the web app's Vitest suite can test it:
// src/lib/__tests__/ebayTransactionReport.test.ts.
//
// The report is a complete ledger of the eBay balance, so for every row the
// amounts booked here must sum to that row's "Net amount" (except Payout rows,
// booked as the transfer out, and intentionally skipped types). The tie-out
// (src/lib/tieOut.ts computePlatformLedger) relies on that.
//
// Fixed 2026-11-13 (owner's 2025/2026 files, simulated row by row):
//  1. Order rows with Transaction ID "0" all got the key ebay_0_order, so the
//     upsert (ignoreDuplicates) kept one and silently dropped the rest: 102
//     orders + their FVF rows in 2025. Now keyed by order number + item ID.
//  2. Only "Final Value Fee - fixed/variable" were booked. Below standard
//     performance, International, Regulatory operating, Very high INAD and
//     Deposit processing fees (2026: $288.77) were lost. Now one `_ofee` row.
//  3. Shipping label / Charge / Hold / Reserve rows sharing a Reference ID
//     (e.g. a label and its later "Underpaid" postage adjustment, both
//     "Tracking no. X") collided. Their keys now include date and amount.
//     Existing rows were re-keyed by migration 20261113140000.
//  4. "Purchase" rows (eBay funds purchase: buying on eBay with the seller
//     balance) were skipped. Now booked as audit rows (cost_of_goods).
//  5. Exact repeats (same key) within one file get `_dup2`, `_dup3`… instead
//     of being dropped.

export const EBAY_OTHER_ORDER_FEE_COLUMNS = [
  'Below standard performance fee',
  'International fee',
  'Regulatory operating fee',
  'Very high "item not as described" fee',
  'Deposit processing fee',
] as const

export interface EbayLedgerRow {
  csv_transaction_id: string
  date: string
  amount: number
  gross_amount: number | null
  merchant: string
  schedule_c_category: string
  /** Order number for order-level rows (tie-out convention); null otherwise. */
  notes: string | null
  /** Payout ID the row belongs to (csv_group_id); null if not yet paid out. */
  csv_group_id: string | null
}

export interface EbayParseResult {
  rows: EbayLedgerRow[]
  /** Rows not booked, by reason (intentional or unknown type). */
  skipped: Record<string, number>
}

const notDash = (s: string | undefined | null): string | null => (s && s !== '--' ? s : null)

export function parseEbayAmount(s: string | undefined | null): number {
  if (!s) return 0
  const t = s.replace(/"/g, '').trim()
  if (t === '' || t === '--') return 0
  const neg = t.startsWith('(') && t.endsWith(')')
  const n = Number(t.replace(/[()$,\s]/g, ''))
  if (!Number.isFinite(n)) return 0
  return neg ? -n : n
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

/** "Nov 9, 2026" / "2026-11-09" / "11/9/2026" → "2026-11-09"; null if unparseable. */
export function parseEbayDate(s: string | undefined | null): string | null {
  if (!s) return null
  const t = s.replace(/"/g, '').trim()
  if (t === '' || t === '--') return null
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  const slash = t.split('/')
  if (slash.length === 3 && slash[2].length === 4) return `${slash[2]}-${slash[0].padStart(2, '0')}-${slash[1].padStart(2, '0')}`
  const m = t.match(/^(\w+)[-\s]+(\d{1,2}),?[-\s]+(\d{4})/)
  if (m) { const mo = MONTHS[m[1].toLowerCase().slice(0, 3)]; if (mo) return `${m[3]}-${mo}-${m[2].padStart(2, '0')}` }
  return null
}

const cents = (n: number) => String(Math.round(n * 100))
/** Content-addressed key segment: same reference, different date/amount → different key. */
const stamp = (date: string, amount: number) => `${date}_${cents(amount)}`

/**
 * Parse every data row of an eBay Transaction Report. `header` is the header
 * row (first cell "Transaction creation date"), `rows` the rows after it.
 */
export function parseEbayTransactionReport(header: string[], rows: string[][]): EbayParseResult {
  const h = header.map(c => c.replace(/"/g, '').trim())
  const idx = new Map(h.map((name, i) => [name, i]))
  const out: EbayLedgerRow[] = []
  const skipped: Record<string, number> = {}
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1 }
  const seen = new Map<string, number>()

  const push = (r: Omit<EbayLedgerRow, 'csv_transaction_id'> & { key: string }) => {
    const n = (seen.get(r.key) ?? 0) + 1
    seen.set(r.key, n)
    const { key, ...rest } = r
    // `_dupN` goes before the type suffix so the suffix stays last.
    const id = n === 1 ? key : key.replace(/_([a-z]+)$/, `_dup${n}_$1`)
    out.push({ csv_transaction_id: id, ...rest })
  }

  for (const raw of rows) {
    if (!raw || raw.length === 0 || raw.every(c => !c || !c.trim())) continue
    const col = (name: string) => {
      const i = idx.get(name)
      return i === undefined ? '' : (raw[i] ?? '').replace(/"/g, '').trim()
    }
    const type = col('Type')
    const date = parseEbayDate(col('Transaction creation date'))
    if (!date) { skip('bad_date'); continue }

    const net = parseEbayAmount(col('Net amount'))
    const gross = parseEbayAmount(col('Gross transaction amount'))
    const payoutId = notDash(col('Payout ID'))
    const transId = notDash(col('Transaction ID'))
    const refId = notDash(col('Reference ID'))
    const orderNumber = notDash(col('Order number'))
    const itemId = notDash(col('Item ID'))
    const itemTitle = col('Item title')
    const description = col('Description')
    const base = { date, gross_amount: null as number | null, csv_group_id: payoutId }

    switch (type) {
      case 'Payout':
        if (net !== 0 && payoutId) push({ ...base, key: `ebay_payout_${payoutId}`, amount: net, merchant: 'eBay Payout', schedule_c_category: 'transfer', notes: null })
        else skip('intentional:Payout')
        break

      case 'Reserve':
      case 'Hold':
        if (net !== 0 && payoutId) {
          const ref = refId || `${date}_${type.toLowerCase()}_${Math.abs(net)}`
          push({ ...base, key: `ebay_${ref}_${stamp(date, net)}_bal`, amount: net, merchant: description.slice(0, 100) || `eBay ${type}`, schedule_c_category: 'balance_adjustment', notes: null })
        } else skip(`intentional:${type}`)
        break

      case 'Transfer':
      case 'Secondary payout':
        skip(`intentional:${type}`)
        break

      case 'Order': {
        // Transaction ID "0" is shared by many rows (multi-item / some 2025
        // orders): key those by order + item instead. "--" keeps the old key.
        const k = transId && transId !== '0' ? transId : (transId === '0' ? `${orderNumber}_${itemId ?? 'hdr'}` : (orderNumber ?? `${date}_${cents(net)}`))
        push({ ...base, key: `ebay_${k}_order`, amount: gross || net, gross_amount: gross || null, merchant: itemTitle || 'eBay Sale', schedule_c_category: 'payout', notes: orderNumber })
        const fvf = parseEbayAmount(col('Final Value Fee - fixed')) + parseEbayAmount(col('Final Value Fee - variable'))
        if (fvf !== 0) push({ ...base, key: `ebay_${k}_fvf`, amount: fvf, merchant: 'eBay Final Value Fee', schedule_c_category: 'commissions_fees', notes: orderNumber })
        const parts = EBAY_OTHER_ORDER_FEE_COLUMNS.map(c => [c, parseEbayAmount(col(c))] as const).filter(([, v]) => v !== 0)
        const other = parts.reduce((t, [, v]) => t + v, 0)
        if (other !== 0) {
          push({ ...base, key: `ebay_${k}_ofee`, amount: Math.round(other * 100) / 100, merchant: `eBay ${parts.map(([c]) => c.replace(/"/g, '')).join(' + ')}`.slice(0, 100), schedule_c_category: 'commissions_fees', notes: orderNumber })
        }
        const charity = parseEbayAmount(col('Charity donation'))
        if (charity !== 0) push({ ...base, key: `ebay_${k}_charity`, amount: charity, merchant: 'eBay charity donation', schedule_c_category: 'other_expense', notes: orderNumber })
        break
      }

      case 'Other fee': {
        const isPromoted = description.toLowerCase().includes('promoted')
        push({ ...base, key: `ebay_${refId || transId || `${orderNumber}_fee`}_fee`, amount: net, merchant: description.slice(0, 100) || 'eBay Fee', schedule_c_category: isPromoted ? 'advertising' : 'commissions_fees', notes: orderNumber })
        break
      }

      case 'Shipping label': {
        const ref = refId || transId || `${date}_ship_${Math.abs(net)}`
        push({ ...base, key: `ebay_${ref}_${stamp(date, net)}_ship`, amount: net, merchant: 'eBay Shipping Label', schedule_c_category: 'shipping_postage', notes: orderNumber })
        break
      }

      case 'Refund': {
        // Transaction ID is always '--' on refunds; the sanitized Reference ID
        // (e.g. "Return_ID_5305955544") is the stable key.
        const safe = (refId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
        push({ ...base, key: `ebay_${safe || `${orderNumber}_${date}_refund`}_refund`, amount: net, merchant: itemTitle || 'eBay Refund', schedule_c_category: 'payout', notes: orderNumber })
        break
      }

      case 'Charge':
        push({ ...base, key: `ebay_${refId || `${date}_charge`}_${stamp(date, net)}_charge`, amount: net, merchant: description.slice(0, 100) || 'eBay Charge', schedule_c_category: 'other_expense', notes: null })
        break

      case 'Claim':
        push({ ...base, key: `ebay_${refId || orderNumber}_claim`, amount: net, merchant: itemTitle || 'eBay Claim', schedule_c_category: 'other_expense', notes: orderNumber })
        break

      case 'Adjustment':
        push({ ...base, key: `ebay_${refId}_adj`, amount: net, merchant: description.slice(0, 100) || 'eBay Adjustment', schedule_c_category: 'other_expense', notes: null })
        break

      case 'Withheld tax':
        push({ ...base, key: `ebay_${refId}_tax`, amount: net, merchant: 'eBay Withheld Tax', schedule_c_category: 'taxes_licenses', notes: null })
        break

      case 'Purchase':
        // "eBay funds purchase": something bought on eBay with the seller
        // balance. Audit row only (csv_import rows never reach Schedule C);
        // the purchase itself must be recorded as an expense / inventory lot.
        push({ ...base, key: `ebay_${transId || refId || orderNumber || 'purchase'}_${stamp(date, net)}_purchase`, amount: net, merchant: `eBay funds purchase: ${itemTitle || description}`.slice(0, 100), schedule_c_category: 'cost_of_goods', notes: orderNumber })
        break

      default:
        skip(`ebay_type:${type || 'empty'}`)
    }
  }
  return { rows: out, skipped }
}
