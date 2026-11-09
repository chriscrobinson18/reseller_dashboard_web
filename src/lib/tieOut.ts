/**
 * Year-End Tie-Out — completeness insurance for sales-based income
 * (owner decision 2026-11-09; docs/bookkeeping-routine.md).
 *
 * Income comes from the Sales tab. Bank deposits from marketplaces are
 * `settlement` rows. If every sale is recorded, each platform's settlement
 * deposits ≈ the net payout of its recorded sales (small timing differences:
 * December sales paid in January). A month with deposits but no recorded
 * sales means sales are missing.
 *
 * Three checks, all pure functions over already-fetched rows:
 *  1. computeTieOut: per platform per month, sales net vs settlement deposits.
 *  2. incomeDepositsNeedingSales: deposits still tagged as income (`payout`):
 *     every one must eventually have matching recorded sales (owner rule).
 *  3. compareEbaySources: per eBay order, Order Earnings (`sales`) vs the
 *     Transaction Report (`csv_import` rows), so re-imports can be targeted.
 *
 * Tests: src/lib/__tests__/tieOut.test.ts. UI: components/TieOutCard.tsx.
 */
import { monthKey } from './utils'

const r2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0

// ─── 1. Sales vs settlement deposits ─────────────────────────────────────────

export interface TieOutSale {
  platform?: string | null
  sold_at: string
  sale_price: number
  fees?: number | null
  shipping_cost?: number | null
  shipping_charged?: number | null
  refunded_amount?: number | null
  net_payout?: number | null
  deleted_at?: string | null
  /** Given side of a trade: non-cash, never deposited, so skipped. */
  trade_id?: string | null
}

export interface TieOutDeposit {
  date: string
  amount: number
  platform?: string | null
}

export interface TieOutMonth { month: string; salesNet: number; deposits: number; saleCount: number; depositCount: number }

export interface TieOutPlatform {
  platform: string
  saleCount: number
  gross: number
  fees: number
  shipping: number
  refunds: number
  salesNet: number
  deposits: number
  depositCount: number
  difference: number          // deposits − salesNet
  months: TieOutMonth[]
  flags: string[]
}

/** A sale's expected payout: its stored net (platform-specific formulas
 *  differ, e.g. TCGplayer adds buyer shipping), else price − fees − postage
 *  + buyer shipping − refunds. */
export function saleNet(s: TieOutSale): number {
  if (s.net_payout != null && Number.isFinite(num(s.net_payout))) return num(s.net_payout)
  return num(s.sale_price) - num(s.fees) - num(s.shipping_cost) + num(s.shipping_charged) - num(s.refunded_amount)
}

/** Difference worth a look: more than 5% of sales net and more than $50. */
export const TIE_OUT_TOLERANCE = { pct: 0.05, abs: 50 }

export function computeTieOut(sales: TieOutSale[], deposits: TieOutDeposit[]): TieOutPlatform[] {
  const byPlat = new Map<string, TieOutPlatform & { m: Map<string, TieOutMonth> }>()
  const get = (p: string) => {
    let e = byPlat.get(p)
    if (!e) {
      e = { platform: p, saleCount: 0, gross: 0, fees: 0, shipping: 0, refunds: 0, salesNet: 0, deposits: 0, depositCount: 0, difference: 0, months: [], flags: [], m: new Map() }
      byPlat.set(p, e)
    }
    return e
  }
  const month = (e: { m: Map<string, TieOutMonth> }, key: string) => {
    let mm = e.m.get(key)
    if (!mm) { mm = { month: key, salesNet: 0, deposits: 0, saleCount: 0, depositCount: 0 }; e.m.set(key, mm) }
    return mm
  }
  for (const s of sales) {
    if (s.deleted_at || s.trade_id) continue
    const e = get((s.platform || 'unassigned').toLowerCase())
    const net = saleNet(s)
    e.saleCount++
    e.gross += num(s.sale_price) + num(s.shipping_charged)
    e.fees += num(s.fees)
    e.shipping += num(s.shipping_cost)
    e.refunds += num(s.refunded_amount)
    e.salesNet += net
    const mm = month(e, monthKey(s.sold_at.slice(0, 10)))
    mm.salesNet += net
    mm.saleCount++
  }
  for (const d of deposits) {
    const e = get((d.platform || 'unassigned').toLowerCase())
    e.deposits += num(d.amount)
    e.depositCount++
    const mm = month(e, monthKey(d.date))
    mm.deposits += num(d.amount)
    mm.depositCount++
  }
  const out: TieOutPlatform[] = []
  for (const e of byPlat.values()) {
    const { m, ...rest } = e
    const p: TieOutPlatform = {
      ...rest,
      gross: r2(rest.gross), fees: r2(rest.fees), shipping: r2(rest.shipping), refunds: r2(rest.refunds),
      salesNet: r2(rest.salesNet), deposits: r2(rest.deposits),
      difference: r2(rest.deposits - rest.salesNet),
      months: [...m.values()].sort((a, b) => a.month.localeCompare(b.month))
        .map(x => ({ ...x, salesNet: r2(x.salesNet), deposits: r2(x.deposits) })),
      flags: [],
    }
    if (p.depositCount > 0 && p.saleCount === 0) p.flags.push('Deposits with no recorded sales')
    const gapMonths = p.months.filter(x => x.deposits > 0 && x.saleCount === 0).map(x => x.month)
    if (gapMonths.length && p.saleCount > 0) p.flags.push(`Deposits but no sales in ${gapMonths.join(', ')}`)
    if (p.saleCount > 0 && p.depositCount > 0 && Math.abs(p.difference) > Math.max(TIE_OUT_TOLERANCE.abs, TIE_OUT_TOLERANCE.pct * Math.abs(p.salesNet))) {
      p.flags.push(p.difference > 0 ? 'Deposits exceed recorded sales: sales may be missing' : 'Recorded sales exceed deposits: payouts may be missing or still pending')
    }
    out.push(p)
  }
  return out.sort((a, b) => (b.salesNet + b.deposits) - (a.salesNet + a.deposits))
}

// ─── 2. Income-tagged deposits ───────────────────────────────────────────────

export interface IncomeDepositInput {
  id: string
  date: string
  amount: number
  merchant?: string | null
  schedule_c_category?: string | null
  record_type?: string | null
  source?: string | null
  related_sale_id?: string | null
  related_bundle_id?: string | null
  trade_id?: string | null
  net_zero_pair_id?: string | null
}

/** Bank deposits still counted as income (`payout`, not linked to a sale). The
 *  owner rule: each must end up with matching recorded sales, then be
 *  re-tagged `settlement`. */
export function incomeDepositsNeedingSales(rows: IncomeDepositInput[]): IncomeDepositInput[] {
  return rows
    .filter(t => t.schedule_c_category === 'payout' && num(t.amount) > 0 && t.record_type !== 'settlement'
      && t.source !== 'csv_import' && !t.related_sale_id && !t.related_bundle_id && !t.trade_id && !t.net_zero_pair_id)
    .sort((a, b) => num(b.amount) - num(a.amount))
}

// ─── 3. eBay: Order Earnings vs Transaction Report ──────────────────────────

export interface EbaySaleInput {
  external_order_id?: string | null
  sold_at: string
  sale_price: number
  fees?: number | null
  shipping_cost?: number | null
  refunded_amount?: number | null
  deleted_at?: string | null
}

export interface EbayCsvRowInput {
  notes?: string | null          // order number
  date: string
  amount: number
  schedule_c_category?: string | null
}

export interface EbayOrderMismatch {
  order: string
  date: string
  fields: Array<{ field: 'gross' | 'fees' | 'shipping' | 'refunds'; earnings: number; report: number }>
}

export interface EbayComparison {
  ordersCompared: number
  matching: number
  mismatched: EbayOrderMismatch[]
  onlyInEarnings: string[]       // order numbers with no Transaction Report rows
  onlyInReport: string[]         // order numbers with no Order Earnings sale
}

/**
 * `year` (optional) limits the result to that tax year: an order counts when
 * its Order Earnings sale is dated in the year, or, if it has no sale, when its
 * first Transaction Report row is. Fetch both sides with a margin of a few
 * weeks around the year so orders that straddle New Year still pair up.
 *
 * Transaction Report rows per order: `payout` positives = gross, `payout`
 * negatives / `returns_allowances` = refunds, `commissions_fees` +
 * `advertising` = fees (promoted listings are a sale fee), `shipping_postage`
 * = labels. A field differs when |earnings − report| ≥ $0.01.
 */
export function compareEbaySources(sales: EbaySaleInput[], csvRows: EbayCsvRowInput[], year?: number): EbayComparison {
  const inYear = (d: string) => year == null || d.slice(0, 4) === String(year)
  type Agg = { date: string; gross: number; fees: number; shipping: number; refunds: number }
  const rep = new Map<string, Agg>()
  for (const r of csvRows) {
    const order = (r.notes ?? '').trim()
    if (!order) continue
    const a = rep.get(order) ?? { date: r.date, gross: 0, fees: 0, shipping: 0, refunds: 0 }
    if (r.date < a.date) a.date = r.date
    const amt = num(r.amount)
    switch (r.schedule_c_category) {
      case 'payout': if (amt >= 0) a.gross += amt; else a.refunds += -amt; break
      case 'returns_allowances': a.refunds += Math.abs(amt); break
      case 'commissions_fees': case 'advertising': a.fees += -amt; break
      case 'shipping_postage': a.shipping += -amt; break
      default: break
    }
    rep.set(order, a)
  }
  // Summed per order, in case an order is ever stored as several sale lines.
  const earn = new Map<string, { sold_at: string; sale_price: number; fees: number; shipping_cost: number; refunded_amount: number }>()
  for (const s of sales) {
    if (s.deleted_at || !s.external_order_id) continue
    const e = earn.get(s.external_order_id)
    if (!e) {
      earn.set(s.external_order_id, { sold_at: s.sold_at, sale_price: num(s.sale_price), fees: num(s.fees), shipping_cost: num(s.shipping_cost), refunded_amount: num(s.refunded_amount) })
    } else {
      e.sale_price += num(s.sale_price); e.fees += num(s.fees); e.shipping_cost += num(s.shipping_cost); e.refunded_amount += num(s.refunded_amount)
      if (s.sold_at < e.sold_at) e.sold_at = s.sold_at
    }
  }

  const out: EbayComparison = { ordersCompared: 0, matching: 0, mismatched: [], onlyInEarnings: [], onlyInReport: [] }
  for (const [order, s] of earn) {
    if (!inYear(s.sold_at)) continue
    const a = rep.get(order)
    if (!a) { out.onlyInEarnings.push(order); continue }
    out.ordersCompared++
    const pairs: EbayOrderMismatch['fields'] = [
      { field: 'gross', earnings: r2(num(s.sale_price)), report: r2(a.gross) },
      { field: 'fees', earnings: r2(num(s.fees)), report: r2(a.fees) },
      { field: 'shipping', earnings: r2(num(s.shipping_cost)), report: r2(a.shipping) },
      { field: 'refunds', earnings: r2(num(s.refunded_amount)), report: r2(a.refunds) },
    ]
    const diff = pairs.filter(p => Math.abs(p.earnings - p.report) >= 0.01)
    if (diff.length) out.mismatched.push({ order, date: s.sold_at.slice(0, 10), fields: diff })
    else out.matching++
  }
  for (const [order, a] of rep) if (!earn.has(order) && inYear(a.date)) out.onlyInReport.push(order)
  out.mismatched.sort((x, y) => x.date.localeCompare(y.date))
  return out
}
