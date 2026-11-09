import type { Sale } from './types'
import { monthKey } from './utils'

/**
 * Schedule C income from the Sales tab — the single source of truth for how a
 * recorded sale reaches the tax form (decided 2026-11-09; see TASKS.md "Books
 * Cleanup" and docs/categories.md "Sales-based income").
 *
 *   Line 1  gross receipts  += sale_price + shipping_charged
 *   Line 2  returns         += refunded_amount
 *   Line 10 fees            += fees            (eBay: includes promoted-listing fees)
 *   Line 27a shipping       += shipping_cost   (postage the PLATFORM deducted)
 *
 * Every non-deleted sale counts, whatever its source (marketplace import,
 * Record Sale, Shortcut, trade legs at fair market value). A fully returned
 * sale stays in Line 1 with its refund on Line 2 — matching how 1099-Ks report
 * gross — so it nets to zero rather than vanishing.
 *
 * Bundles: line rows store fees = 0 / shipping_cost = null by design; the
 * order-level charge lives once on `sale_bundles`. Pass the bundles so their
 * fees/shipping are counted exactly once (dated by the bundle's own sold_at).
 *
 * Bank deposits never carry this income: marketplace payouts are `settlement`
 * rows, and the transactions that Record Sale / bundles / CSV imports create
 * are excluded from Schedule C by `bucketTransaction` (audit detail only).
 */

/** The subset of a `sales` row this module reads. */
export type SaleIncomeInput = Pick<
  Sale,
  'sale_price' | 'fees' | 'shipping_charged' | 'refunded_amount' | 'sold_at' | 'deleted_at'
> & {
  /** Nullable in the DB (TCGplayer rows after the 2026-11-09 migration). */
  shipping_cost?: number | null
  platform?: string | null
}

/** The subset of a `sale_bundles` row this module reads. */
export interface BundleIncomeInput {
  fees: number | null
  shipping_cost: number | null
  sold_at: string
  deleted_at?: string | null
}

export interface SalesIncomeTotals {
  grossReceipts: number    // Line 1 (positive)
  returns: number          // Line 2 (positive magnitude)
  fees: number             // Line 10 (positive magnitude)
  platformShipping: number // Line 27a (positive magnitude)
  saleCount: number
}

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function emptySalesIncome(): SalesIncomeTotals {
  return { grossReceipts: 0, returns: 0, fees: 0, platformShipping: 0, saleCount: 0 }
}

/** One sale's contribution. Magnitudes are taken with abs() defensively: the
 *  columns are documented as unsigned, so a stray sign must not flip a line. */
export function saleIncomeParts(s: SaleIncomeInput): Omit<SalesIncomeTotals, 'saleCount'> {
  return {
    grossReceipts: num(s.sale_price) + Math.abs(num(s.shipping_charged)),
    returns: Math.abs(num(s.refunded_amount)),
    fees: Math.abs(num(s.fees)),
    platformShipping: Math.abs(num(s.shipping_cost)),
  }
}

function add(t: SalesIncomeTotals, p: Omit<SalesIncomeTotals, 'saleCount'>) {
  t.grossReceipts += p.grossReceipts
  t.returns += p.returns
  t.fees += p.fees
  t.platformShipping += p.platformShipping
}

/** Totals for the given sales + bundles. Callers pre-filter by period; deleted
 *  rows are skipped here regardless. */
export function computeSalesIncome(
  sales: SaleIncomeInput[],
  bundles: BundleIncomeInput[] = [],
): SalesIncomeTotals {
  const t = emptySalesIncome()
  for (const s of sales) {
    if (s.deleted_at) continue
    add(t, saleIncomeParts(s))
    t.saleCount += 1
  }
  for (const b of bundles) {
    if (b.deleted_at) continue
    t.fees += Math.abs(num(b.fees))
    t.platformShipping += Math.abs(num(b.shipping_cost))
  }
  return t
}

/** Same totals keyed by 'yyyy-MM' of sold_at (for the monthly chart). */
export function computeSalesIncomeByMonth(
  sales: SaleIncomeInput[],
  bundles: BundleIncomeInput[] = [],
): Record<string, SalesIncomeTotals> {
  const out: Record<string, SalesIncomeTotals> = {}
  const get = (d: string) => (out[monthKey(d.slice(0, 10))] ??= emptySalesIncome())
  for (const s of sales) {
    if (s.deleted_at) continue
    const t = get(s.sold_at)
    add(t, saleIncomeParts(s))
    t.saleCount += 1
  }
  for (const b of bundles) {
    if (b.deleted_at) continue
    const t = get(b.sold_at)
    t.fees += Math.abs(num(b.fees))
    t.platformShipping += Math.abs(num(b.shipping_cost))
  }
  return out
}

/** Net effect on profit: income minus selling costs. */
export function salesIncomeNet(t: SalesIncomeTotals): number {
  return t.grossReceipts - t.returns - t.fees - t.platformShipping
}
