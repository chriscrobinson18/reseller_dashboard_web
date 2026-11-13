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
import { EBAY_STORE_SUBSCRIPTION } from './categories'

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
  /** How the buyer paid — routes in-person sales to their wallet's deposits. */
  payment_method?: string | null
  /** Split-payment breakdown (payment_method = 'split'). */
  payments?: { method: string; amount: number }[] | null
}

/**
 * Venues with no settlement of their own: the money lands through whatever
 * rail the buyer used, so the tie-out files the sale under that rail's deposit
 * label instead of e.g. 'manual' (whose deposits never exist).
 */
export const IN_PERSON_PLATFORMS = new Set(['manual', 'facebook marketplace', 'facebook groups', 'discord'])

/** payment_method → deposit platform label. 'cash' has no deposits by nature. */
export const RAIL_DEPOSIT_PLATFORM: Record<string, string> = {
  paypal: 'paypal', venmo: 'venmo', cashapp: 'cashapp', zelle: 'zelle', cash: 'cash',
}

/** Rails whose money never arrives as a tagged deposit, so "no deposits" is expected. */
export const NO_DEPOSIT_PLATFORMS = new Set(['cash'])

/**
 * Where a sale's money should show up, as [platform key, share of the sale].
 * Marketplaces settle under their own name. In-person sales go to their
 * payment rail (split payments proportionally); with no usable rail they stay
 * under their platform and get flagged.
 */
export function tieOutTargets(s: TieOutSale): Array<{ key: string; share: number }> {
  const platform = (s.platform || 'unassigned').toLowerCase()
  if (!IN_PERSON_PLATFORMS.has(platform)) return [{ key: platform, share: 1 }]
  if (s.payments && s.payments.length > 0) {
    const total = s.payments.reduce((t, p) => t + num(p.amount), 0)
    if (total > 0) {
      const byKey = new Map<string, number>()
      for (const p of s.payments) {
        const key = RAIL_DEPOSIT_PLATFORM[p.method] ?? platform
        byKey.set(key, (byKey.get(key) ?? 0) + num(p.amount) / total)
      }
      return [...byKey].map(([key, share]) => ({ key, share }))
    }
  }
  const rail = s.payment_method ? RAIL_DEPOSIT_PLATFORM[s.payment_method] : undefined
  return [{ key: rail ?? platform, share: 1 }]
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
  /** Informational, not a problem (e.g. a balance held on eBay, a TCGplayer payout still pending). */
  notes: string[]
  /** Full report reconciliation (eBay/Amazon with an imported report) — replaces the timing rules. */
  ledger?: PlatformLedger
}

/**
 * Marketplaces whose payouts don't line up with sale dates. eBay and Amazon
 * hold the seller's balance and spend from it (shipping labels, promoted-
 * listing/ad fees, reserves) before paying out; TCGplayer pays out on its own
 * schedule, so a sale and its payout often land in different months. Their
 * deposits legitimately lag or lead recorded sales, monthly and across a year
 * end, so they get no monthly flags and are judged on direction instead of a
 * tolerance: sales > deposits is money not yet paid out or spent on the
 * platform (normal); deposits > sales is only explainable by last year's
 * held balance.
 */
export const HELD_BALANCE_PLATFORMS = new Set(['ebay', 'amazon', 'tcgplayer'])

/** Prior tax year's sales/deposits, used for held-balance platforms' carry-in. */
export interface TieOutPrior {
  sales: TieOutSale[]
  deposits: TieOutDeposit[]
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

export function computeTieOut(sales: TieOutSale[], deposits: TieOutDeposit[], prior?: TieOutPrior): TieOutPlatform[] {
  // Last year's held balance per held-balance platform (sales net - deposits,
  // floored at 0), and whether last year had any recorded sales to judge by.
  const carry = new Map<string, { held: number; known: boolean }>()
  if (prior) {
    for (const p of computeTieOut(prior.sales, prior.deposits)) {
      if (!HELD_BALANCE_PLATFORMS.has(p.platform)) continue
      carry.set(p.platform, { held: Math.max(0, -p.difference), known: p.saleCount > 0 })
    }
  }
  const byPlat = new Map<string, TieOutPlatform & { m: Map<string, TieOutMonth> }>()
  const get = (p: string) => {
    let e = byPlat.get(p)
    if (!e) {
      e = { platform: p, saleCount: 0, gross: 0, fees: 0, shipping: 0, refunds: 0, salesNet: 0, deposits: 0, depositCount: 0, difference: 0, months: [], flags: [], notes: [], m: new Map() }
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
    const net = saleNet(s)
    // A split sale counts once on each rail it touched, with its share of the money.
    for (const { key, share } of tieOutTargets(s)) {
      const e = get(key)
      e.saleCount++
      e.gross += (num(s.sale_price) + num(s.shipping_charged)) * share
      e.fees += num(s.fees) * share
      e.shipping += num(s.shipping_cost) * share
      e.refunds += num(s.refunded_amount) * share
      e.salesNet += net * share
      const mm = month(e, monthKey(s.sold_at.slice(0, 10)))
      mm.salesNet += net * share
      mm.saleCount++
    }
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
      notes: [],
    }
    if (HELD_BALANCE_PLATFORMS.has(p.platform) && p.saleCount > 0 && p.depositCount > 0) {
      out.push(judgeHeldBalance(p, carry.get(p.platform), prior !== undefined))
      continue
    }
    if (p.depositCount > 0 && p.saleCount === 0) p.flags.push('Deposits with no recorded sales')
    if (p.saleCount > 0 && p.depositCount === 0 && !NO_DEPOSIT_PLATFORMS.has(p.platform)) {
      p.flags.push(IN_PERSON_PLATFORMS.has(p.platform)
        ? 'In-person sales with no payment method: set one so they match a wallet deposit'
        : 'Recorded sales but no deposits: payouts untagged, missing, or paid out under another name')
    }
    const gapMonths = p.months.filter(x => x.deposits > 0 && x.saleCount === 0).map(x => x.month)
    if (gapMonths.length && p.saleCount > 0) p.flags.push(`Deposits but no sales in ${gapMonths.join(', ')}`)
    if (p.saleCount > 0 && p.depositCount > 0 && Math.abs(p.difference) > Math.max(TIE_OUT_TOLERANCE.abs, TIE_OUT_TOLERANCE.pct * Math.abs(p.salesNet))) {
      p.flags.push(p.difference > 0 ? 'Deposits exceed recorded sales: sales may be missing' : 'Recorded sales exceed deposits: payouts may be missing or still pending')
    }
    out.push(p)
  }
  return out.sort((a, b) => (b.salesNet + b.deposits) - (a.salesNet + a.deposits))
}

const fmt = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** eBay/Amazon/TCGplayer: direction-based, with last year's held balance as carry-in. No monthly flags. */
function judgeHeldBalance(p: TieOutPlatform, carry: { held: number; known: boolean } | undefined, hadPrior: boolean): TieOutPlatform {
  const tol = Math.max(TIE_OUT_TOLERANCE.abs, TIE_OUT_TOLERANCE.pct * Math.abs(p.salesNet))
  if (p.difference <= 0) {
    if (p.difference < 0) p.notes.push(`About ${fmt(p.difference)} not yet paid out or spent on the platform (pending payouts, labels, ads, reserves)`)
    return p
  }
  // Deposits exceed this year's sales: fine if last year left that much on the platform.
  const excess = p.difference
  if (carry && carry.known) {
    if (excess <= carry.held + tol) {
      p.notes.push(`Deposits exceed this year's sales by ${fmt(excess)}, covered by ${fmt(carry.held)} held at the end of last year`)
    } else {
      p.flags.push(`Deposits exceed sales plus last year's held balance (${fmt(carry.held)}) by ${fmt(excess - carry.held)}: sales may be missing`)
    }
  } else {
    p.notes.push(`Deposits exceed this year's sales by ${fmt(excess)}, likely a balance carried in from last year${hadPrior ? ' (no sales recorded then to confirm)' : ''}`)
  }
  return p
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


// ─── 4. Platform ledger: explain every dollar (eBay, Amazon) ─────────────────
//
// eBay and Amazon reports (`csv_import` rows) are complete ledgers of the
// seller balance: sale credits, fees, labels, ads, subscriptions, holds and
// every payout. So the gap between recorded sales and bank deposits is fully
// explainable:
//
//   recorded sales net                       (A, Sales tab)
// + order differences = report order net − A, per order        (sales check;
//                       order rows incl. promoted-listing fees, as Order Earnings)
// + not tied to an order (ads, store fees, labels, charges, holds)   (C)
// − change in balance held on the platform   (E = Σ every report row)
// = payouts in the platform report           (D = −Σ transfer rows)
//
// D = A + orderDiff + C − E holds by construction. Report payouts are then
// matched 1:1 to bank deposits; anything left unmatched is the only truly
// unexplained money. Order differences are listed per order (usually fees or
// labels that Order Earnings and the Transaction Report book differently).

/** Platforms whose imported report includes every balance movement and payout. */
export const LEDGER_PLATFORMS = new Set(['ebay', 'amazon'])

export interface LedgerRow {
  date: string
  amount: number
  schedule_c_category: string | null
  /** Order id for order-level rows (CSV import convention); null otherwise. */
  notes: string | null
  merchant?: string | null
  platform?: string | null
}

export interface LedgerSale extends TieOutSale {
  external_order_id?: string | null
}

export interface LedgerLine { label: string; amount: number; count: number }

/** A non-report transaction (bank/card feed or manual) a report row can be matched to. */
export interface LedgerBookRow {
  date: string
  amount: number
  schedule_c_category: string | null
  record_type?: string | null
  platform?: string | null
  merchant?: string | null
}

export interface LedgerGhost { date: string; amount: number; description: string; reason: string }

export interface LedgerOrderDiff { orderId: string; date: string; recorded: number | null; report: number | null; difference: number }

export interface LedgerPayoutMatch { date: string; amount: number; bankDate: string; bankAmount: number; fee: number }

export interface PlatformLedger {
  platform: string
  /** Report rows exist for this year; without them the platform falls back to timing rules. */
  hasReport: boolean
  recordedNet: number
  reportOrderNet: number
  /** reportOrderNet − recordedNet (sum of `orderDiffs`). */
  orderDifference: number
  /**
   * Labels the report bills with no order number. eBay Order Earnings (the
   * Sales tab) charges each one to its order, so they show up as order
   * differences of the opposite sign. Negative.
   */
  separateLabels: number
  /** orderDifference + separateLabels: what the label attribution doesn't explain. Should be ~0. */
  orderDifferenceAfterLabels: number
  orderDiffs: LedgerOrderDiff[]
  /** C, by type: rows with no order number (store subscription, labels bought separately, charges, holds…). */
  notOnOrders: LedgerLine[]
  notOnOrdersTotal: number
  /** Σ every report row in the year incl. payouts. Positive = more held at year end than at the start. */
  balanceChange: number
  reportPayouts: number
  reportPayoutCount: number
  bankDeposits: number
  bankDepositCount: number
  /** bankDeposits − reportPayouts. */
  payoutGap: number
  /** Payouts that reached the bank short by a small transfer fee (eBay instant payouts). */
  feeMatched: LedgerPayoutMatch[]
  transferFees: number
  /** Bank deposits dated before the first report row: payouts of a balance from before the report starts. */
  beforeReport: { date: string; amount: number }[]
  unmatchedReportPayouts: { date: string; amount: number }[]
  unmatchedBankDeposits: { date: string; amount: number }[]
  /** bankDeposits − reportPayouts not covered by transfer fees or pre-report deposits. Should be ~0. */
  unexplained: number
  /**
   * Report rows with no order number that reach your books by NO path: not on
   * Schedule C, not covered by the Sales tab, not matched to a bank/card row.
   * The class of row that hid the eBay store fee until 2026-11-13.
   */
  ghosts: LedgerGhost[]
  flags: string[]
}

const NOT_ON_ORDER_LABELS: Record<string, string> = {
  advertising: 'Promoted listings / ads not on an order',
  commissions_fees: 'Store subscription & fees not on an order',
  shipping_postage: 'Shipping labels not on an order',
  other_expense: 'Other charges & credits',
  balance_adjustment: 'Holds & balance adjustments',
  payout: 'Credits not tied to an order',
  cost_of_goods: 'eBay funds purchases (inventory bought with your balance)',
}

/** eBay "Charge for … from Visa/Chase …" rows: eBay pulled money from your card or bank to cover a negative balance. */
const LABEL_PAID_IN = 'Paid in from your card/bank (eBay charges)'
const LABEL_SEPARATE_SHIPPING = NOT_ON_ORDER_LABELS.shipping_postage

const dayNum = (d: string) => Date.parse(d.slice(0, 10) + 'T00:00:00Z') / 86_400_000

/** Matching windows: exact amounts can arrive late (Amazon's $0.01 test deposit took 22 days). */
export const PAYOUT_MATCH = { exactDays: 30, feeDays: 10, maxFee: 5 }

/**
 * One platform's ledger for `year`. `rows` and `deposits` may include a margin
 * around the year (for payout matching across New Year); totals use in-year
 * rows only. `tolerance` is the order difference treated as zero.
 */
export function computePlatformLedger(
  platform: string,
  year: number,
  sales: LedgerSale[],
  rows: LedgerRow[],
  deposits: TieOutDeposit[],
  /** Non-report transactions (bank/card feed, manual) for matching charges and purchases. */
  books: LedgerBookRow[] = [],
  tolerance = 5,
): PlatformLedger {
  const noOrder: LedgerRow[] = []
  const inYear = (d: string) => d.slice(0, 4) === String(year)
  const mine = <T extends { platform?: string | null }>(xs: T[]) => xs.filter(x => (x.platform ?? '').toLowerCase() === platform)
  const myRows = mine(rows)

  // A, per order.
  const recordedByOrder = new Map<string, { net: number; date: string }>()
  let recordedNet = 0
  for (const s of mine(sales)) {
    if (s.deleted_at || s.trade_id || !inYear(s.sold_at)) continue
    const net = saleNet(s)
    recordedNet += net
    const key = s.external_order_id || `sale:${s.sold_at}:${s.sale_price}`
    const e = recordedByOrder.get(key) ?? { net: 0, date: s.sold_at.slice(0, 10) }
    e.net += net
    recordedByOrder.set(key, e)
  }

  let reportOrderNet = 0, balanceChange = 0, reportPayouts = 0, reportPayoutCount = 0
  const reportByOrder = new Map<string, { net: number; date: string }>()
  const notOn = new Map<string, LedgerLine>()
  const reportPayoutRows: { date: string; amount: number }[] = []
  for (const r of myRows) {
    const amt = num(r.amount)
    const cat = r.schedule_c_category ?? 'uncategorized'
    if (cat === 'transfer') reportPayoutRows.push({ date: r.date, amount: -amt })
    if (!inYear(r.date)) continue
    balanceChange += amt
    if (cat === 'transfer') { reportPayouts += -amt; reportPayoutCount++; continue }
    // Order rows: anything carrying an order number. Ads included: eBay Order
    // Earnings counts the Promoted Listing Standard fee in the order's fees.
    // Purchases (eBay funds purchase) carry the order number of something you
    // BOUGHT, so they're never one of your sales.
    if (r.notes && cat !== 'cost_of_goods') {
      reportOrderNet += amt
      const e = reportByOrder.get(r.notes) ?? { net: 0, date: r.date }
      e.net += amt
      reportByOrder.set(r.notes, e)
      continue
    }
    noOrder.push(r)
    const label = cat === 'other_expense' && /^charge for /i.test(r.merchant ?? '')
      ? LABEL_PAID_IN
      : (NOT_ON_ORDER_LABELS[cat] ?? cat)
    const line = notOn.get(label) ?? { label, amount: 0, count: 0 }
    line.amount += amt; line.count++
    notOn.set(label, line)
  }

  const orderDiffs: LedgerOrderDiff[] = []
  for (const id of new Set([...recordedByOrder.keys(), ...reportByOrder.keys()])) {
    const a = recordedByOrder.get(id), b = reportByOrder.get(id)
    const d = r2((b?.net ?? 0) - (a?.net ?? 0))
    if (Math.abs(d) < 0.01) continue
    orderDiffs.push({
      orderId: id.startsWith('sale:') ? '(no order id)' : id,
      date: (a ?? b)!.date,
      recorded: a ? r2(a.net) : null,
      report: b ? r2(b.net) : null,
      difference: d,
    })
  }
  orderDiffs.sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference))

  // Payout matching.
  const bank = mine(deposits).map(d => ({ date: d.date, amount: num(d.amount) }))
  let bankDeposits = 0, bankDepositCount = 0
  for (const d of bank) if (inYear(d.date)) { bankDeposits += d.amount; bankDepositCount++ }
  const used = new Set<number>()
  const pick = (p: { date: string; amount: number }, ok: (d: { date: string; amount: number }) => boolean, days: number) => {
    let best = -1, bestGap = Infinity
    bank.forEach((d, i) => {
      if (used.has(i) || !ok(d)) return
      const g = Math.abs(dayNum(d.date) - dayNum(p.date))
      if (g <= days && g < bestGap) { best = i; bestGap = g }
    })
    if (best >= 0) used.add(best)
    return best
  }
  const payouts = [...reportPayoutRows].sort((a, b) => a.date.localeCompare(b.date))
  const leftover: typeof payouts = []
  for (const p of payouts) {
    if (pick(p, d => Math.abs(d.amount - p.amount) <= 0.01, PAYOUT_MATCH.exactDays) < 0) leftover.push(p)
  }
  const feeMatched: LedgerPayoutMatch[] = []
  const unmatchedReportPayouts: { date: string; amount: number }[] = []
  for (const p of leftover) {
    const i = pick(p, d => d.amount < p.amount && p.amount - d.amount <= PAYOUT_MATCH.maxFee, PAYOUT_MATCH.feeDays)
    if (i >= 0) {
      if (inYear(p.date)) feeMatched.push({ date: p.date, amount: r2(p.amount), bankDate: bank[i].date, bankAmount: r2(bank[i].amount), fee: r2(p.amount - bank[i].amount) })
    } else if (inYear(p.date)) {
      unmatchedReportPayouts.push({ date: p.date, amount: r2(p.amount) })
    }
  }
  const firstReport = myRows.reduce<string | null>((m, r) => (m === null || r.date < m ? r.date : m), null)
  const beforeReport: { date: string; amount: number }[] = []
  const unmatchedBankDeposits: { date: string; amount: number }[] = []
  bank.forEach((d, i) => {
    if (used.has(i) || !inYear(d.date)) return
    const row = { date: d.date, amount: r2(d.amount) }
    if (firstReport && dayNum(d.date) <= dayNum(firstReport) + 7) beforeReport.push(row)
    else unmatchedBankDeposits.push(row)
  })

  const notOnOrders = [...notOn.values()]
    .map(l => ({ ...l, amount: r2(l.amount) }))
    .filter(l => Math.abs(l.amount) >= 0.005)
    .sort((a, b) => a.amount - b.amount)
  const transferFees = r2(feeMatched.reduce((t, m) => t + m.fee, 0))
  const beforeTotal = beforeReport.reduce((t, d) => t + d.amount, 0)
  const payoutGap = r2(bankDeposits - reportPayouts)
  // Ghost check: every report row without an order number must reach your
  // books by some path, or it is listed here.
  const usedBook = new Set<number>()
  const matchBook = (want: number, date: string, ok: (b: LedgerBookRow) => boolean) => {
    let best = -1, bestGap = Infinity
    books.forEach((b, i) => {
      if (usedBook.has(i) || !ok(b) || Math.abs(num(b.amount) - want) > 0.01) return
      const g = Math.abs(dayNum(b.date) - dayNum(date))
      if (g <= 7 && g < bestGap) { best = i; bestGap = g }
    })
    if (best >= 0) usedBook.add(best)
    return best >= 0
  }
  const ghosts: LedgerGhost[] = []
  for (const r of noOrder) {
    const amt = num(r.amount)
    if (Math.abs(amt) < 0.005) continue
    const cat = r.schedule_c_category ?? 'uncategorized'
    const desc = r.merchant || cat
    if (cat === 'shipping_postage') continue      // Sales tab charges it to its order (checked via orderDifferenceAfterLabels)
    if (cat === 'balance_adjustment') continue    // holds / debt carry: balance mechanics, net to zero
    if (cat === 'commissions_fees' && platform === 'ebay' && EBAY_STORE_SUBSCRIPTION.test(r.merchant ?? '')) continue // on Schedule C
    if (cat === 'other_expense' && /^charge for /i.test(r.merchant ?? '')) {
      // eBay pulled money from a card/bank: that charge must be in the books as a settlement.
      if (!matchBook(-amt, r.date, b => b.record_type === 'settlement' || b.schedule_c_category === 'settlement')) {
        ghosts.push({ date: r.date, amount: r2(amt), description: desc, reason: 'This charge to your card/bank is not in your books (a card or account that does not sync?)' })
      }
      continue
    }
    if (cat === 'cost_of_goods') {
      // Bought on the platform with your balance: must be recorded as a purchase.
      if (!matchBook(amt, r.date, b => b.schedule_c_category === 'cost_of_goods')) {
        ghosts.push({ date: r.date, amount: r2(amt), description: desc, reason: 'Purchase paid from your balance is not recorded as an inventory purchase' })
      }
      continue
    }
    ghosts.push({ date: r.date, amount: r2(amt), description: desc, reason: 'Not on Schedule C and not covered by the Sales tab or a bank row' })
  }
  // A charge and its later reversal (same description, equal and opposite,
  // e.g. an insertion fee credited back) net to nothing: not a ghost.
  for (let i = 0; i < ghosts.length; i++) {
    const j = ghosts.findIndex((g, k) => k !== i && g.description === ghosts[i].description
      && Math.abs(g.amount + ghosts[i].amount) < 0.005 && Math.abs(dayNum(g.date) - dayNum(ghosts[i].date)) <= 90)
    if (j >= 0) { ghosts.splice(Math.max(i, j), 1); ghosts.splice(Math.min(i, j), 1); i = -1 }
  }

  const out: PlatformLedger = {
    platform,
    hasReport: myRows.some(r => inYear(r.date)),
    recordedNet: r2(recordedNet),
    reportOrderNet: r2(reportOrderNet),
    orderDifference: r2(reportOrderNet - recordedNet),
    separateLabels: r2(notOnOrders.find(l => l.label === LABEL_SEPARATE_SHIPPING)?.amount ?? 0),
    orderDifferenceAfterLabels: r2(reportOrderNet - recordedNet + (notOnOrders.find(l => l.label === LABEL_SEPARATE_SHIPPING)?.amount ?? 0)),
    orderDiffs,
    notOnOrders,
    notOnOrdersTotal: r2(notOnOrders.reduce((t, l) => t + l.amount, 0)),
    balanceChange: r2(balanceChange),
    reportPayouts: r2(reportPayouts),
    reportPayoutCount,
    bankDeposits: r2(bankDeposits),
    bankDepositCount,
    payoutGap,
    feeMatched,
    transferFees,
    beforeReport,
    unmatchedReportPayouts,
    unmatchedBankDeposits,
    unexplained: r2(payoutGap + transferFees - beforeTotal),
    ghosts,
    flags: [],
  }
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (ghosts.length) out.flags.push(`${plural(ghosts.length, 'report row')} not accounted for anywhere (ghost${ghosts.length === 1 ? '' : 's'}): ${ghosts.map(g => '$' + Math.abs(g.amount).toFixed(2)).join(', ')}`)
  if (unmatchedReportPayouts.length) out.flags.push(`${plural(unmatchedReportPayouts.length, 'payout')} in the report not found in the bank`)
  if (unmatchedBankDeposits.length) out.flags.push(`${plural(unmatchedBankDeposits.length, 'bank deposit')} not in the report`)
  if (Math.abs(out.orderDifferenceAfterLabels) > tolerance) {
    const d = out.orderDifferenceAfterLabels
    out.flags.push(`Sales tab differs from the report by ${d > 0 ? '+' : '−'}$${Math.abs(d).toFixed(2)} after labels bought separately (see orders)`)
  }
  return out
}

/**
 * Swap the timing rules for the report reconciliation on platforms that have
 * an imported report for the year: flags come from the ledger (unmatched
 * payouts, order differences) and the held-balance notes are dropped, since
 * the bridge explains the gap line by line.
 */
export function applyLedgers(platforms: TieOutPlatform[], ledgers: PlatformLedger[]): TieOutPlatform[] {
  const byPlatform = new Map(ledgers.filter(l => l.hasReport).map(l => [l.platform, l]))
  return platforms.map(p => {
    const ledger = byPlatform.get(p.platform)
    return ledger ? { ...p, ledger, flags: [...ledger.flags], notes: [] } : p
  })
}
