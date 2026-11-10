// Pure per-order aggregation of marketplace Transaction Report rows
// (`transactions` with source = 'csv_import'), used by
// sync_csv_orders_to_sales (Amazon / Mercari). No Deno or npm imports, so the
// web app's Vitest suite can test it: src/lib/__tests__/csvOrderAggregate.test.ts.
//
// Sign conventions (all amounts as stored on `transactions`):
//   payout > 0           → gross revenue; earliest such row dates the sale
//   payout < 0           → refund to the buyer
//   commissions_fees     → signed: −x is a fee, +x a fee reversal
//   shipping_postage     → signed: −x is postage paid, +x a postage refund /
//                          credit (fixed 2026-11-10, sync v6: v1–v5 used
//                          Math.abs, so credits were counted as more postage)

export interface CsvOrderRow {
  date: string
  amount: number | string
  merchant?: string | null
  notes?: string | null
  schedule_c_category?: string | null
}

export interface CsvOrderEntry {
  grossRevenue: number
  refundedAmount: number
  fees: number
  shippingCost: number
  date: string
  productName: string | null
}

export const CSV_SYNC_SKIP_CATEGORIES = new Set([
  'transfer', 'balance_adjustment', 'taxes_licenses', 'settlement',
])

/** Group rows by order reference (`notes`). Expects rows sorted by date. */
export function aggregateCsvOrders(rows: CsvOrderRow[]): Map<string, CsvOrderEntry> {
  const orderMap = new Map<string, CsvOrderEntry>()
  for (const tx of rows) {
    const ref = tx.notes
    if (!ref || ref === '' || ref === '--') continue
    const cat = tx.schedule_c_category ?? ''
    if (CSV_SYNC_SKIP_CATEGORIES.has(cat)) continue

    const entry: CsvOrderEntry = orderMap.get(ref) ?? {
      grossRevenue: 0, refundedAmount: 0, fees: 0,
      shippingCost: 0, date: tx.date, productName: null,
    }
    const amount = Number(tx.amount)

    if (cat === 'payout') {
      if (amount > 0) {
        entry.grossRevenue += amount
        if (tx.date < entry.date) entry.date = tx.date
        if (!entry.productName && tx.merchant) entry.productName = tx.merchant
      } else {
        entry.refundedAmount += Math.abs(amount)
      }
    } else if (cat === 'commissions_fees') {
      entry.fees -= amount
    } else if (cat === 'shipping_postage') {
      entry.shippingCost -= amount
    }
    orderMap.set(ref, entry)
  }
  return orderMap
}

/** Money fields written to `sales` for one order (semantics unchanged since v4:
 *  sale_price = gross − refunds). */
export function csvOrderSaleFields(e: CsvOrderEntry) {
  const salePrice = e.grossRevenue - e.refundedAmount
  return {
    sale_price: salePrice,
    fees: e.fees,
    shipping_cost: e.shippingCost,
    net_payout: salePrice - e.fees - e.shippingCost,
    return_status: e.refundedAmount === 0 ? 'none' : e.refundedAmount >= e.grossRevenue ? 'full' : 'partial',
  }
}
