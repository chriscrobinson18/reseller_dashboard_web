import type { Transaction } from './types'

/**
 * Net-zero matching: find transactions whose amounts cancel exactly (a charge
 * and its refund, a transfer out and back in). A net-zero pair shares a
 * `net_zero_pair_id` and both rows drop out of every Schedule C total
 * (`bucketTransaction`). See docs/features/expenses.md "Net-zero matching".
 *
 * Rules:
 *  - exact opposite amount, compared in whole cents
 *  - only rows that can be paired: not already paired, not a marketplace report
 *    row (`csv_import`), not part of a trade, not linked to a sale or bundle
 *  - ranked same merchant first, then nearest date
 */

export type NetZeroRow = Pick<
  Transaction,
  'id' | 'date' | 'amount' | 'merchant' | 'account_display' | 'schedule_c_category' | 'source' | 'record_type'
  | 'net_zero_pair_id' | 'trade_id' | 'related_sale_id' | 'related_bundle_id' | 'review_status'
>

export const NET_ZERO_SELECT =
  'id, date, amount, merchant, account_display, schedule_c_category, source, record_type, net_zero_pair_id, trade_id, related_sale_id, related_bundle_id, review_status'

const cents = (n: number) => Math.round(Number(n) * 100)
const dayNum = (d: string) => Date.parse(d.slice(0, 10) + 'T00:00:00Z') / 86_400_000

export function daysApart(a: string, b: string): number {
  return Math.abs(Math.round(dayNum(a) - dayNum(b)))
}

/** Can this row take part in a net-zero pair? */
export function isPairable(t: NetZeroRow): boolean {
  return !t.net_zero_pair_id && !t.trade_id && !t.related_sale_id && !t.related_bundle_id
    && t.source !== 'csv_import' && cents(t.amount) !== 0
}

/** Two amounts cancel to the cent. */
export function cancelsOut(a: number, b: number): boolean {
  return cents(a) !== 0 && cents(a) + cents(b) === 0
}

const normMerchant = (m: string | null | undefined) =>
  (m ?? '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Same merchant: identical once normalized, or the same first word (4+ letters, e.g. "amazon mktp" vs "amazon com"). */
export function sameMerchant(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normMerchant(a), y = normMerchant(b)
  if (!x || !y) return false
  if (x === y) return true
  const fx = x.split(' ')[0], fy = y.split(' ')[0]
  return fx.length >= 4 && fx === fy
}

export interface NetZeroCandidate<T extends NetZeroRow = NetZeroRow> {
  row: T
  sameMerchant: boolean
  days: number
}

/** Candidates for one transaction, best first. */
export function rankNetZeroCandidates<T extends NetZeroRow>(tx: NetZeroRow, rows: T[]): NetZeroCandidate<T>[] {
  return rows
    .filter(r => r.id !== tx.id && isPairable(r) && cancelsOut(tx.amount, r.amount))
    .map(row => ({ row, sameMerchant: sameMerchant(tx.merchant, row.merchant), days: daysApart(tx.date, row.date) }))
    .sort((a, b) => Number(b.sameMerchant) - Number(a.sameMerchant) || a.days - b.days || a.row.date.localeCompare(b.row.date))
}

export interface NetZeroProposal<T extends NetZeroRow = NetZeroRow> {
  negative: T
  positive: T
  sameMerchant: boolean
  days: number
}

/**
 * One-to-one pairs across a set of rows: for each exact amount, every
 * negative/positive combination within `maxDays` is scored (same merchant
 * first, then fewest days apart) and taken greedily, so each row is used at
 * most once. `inScope` keeps only proposals touching the period being viewed.
 */
export function proposeNetZeroPairs<T extends NetZeroRow>(
  rows: T[],
  opts: { maxDays?: number; inScope?: (r: T) => boolean } = {},
): NetZeroProposal<T>[] {
  const maxDays = opts.maxDays ?? 120
  const byAmount = new Map<number, { neg: T[]; pos: T[] }>()
  for (const r of rows) {
    if (!isPairable(r)) continue
    const c = cents(r.amount)
    const g = byAmount.get(Math.abs(c)) ?? { neg: [], pos: [] }
    if (c < 0) g.neg.push(r)
    else g.pos.push(r)
    byAmount.set(Math.abs(c), g)
  }
  const out: NetZeroProposal<T>[] = []
  for (const { neg, pos } of byAmount.values()) {
    if (!neg.length || !pos.length) continue
    const combos: NetZeroProposal<T>[] = []
    for (const n of neg) for (const p of pos) {
      const days = daysApart(n.date, p.date)
      if (days <= maxDays) combos.push({ negative: n, positive: p, sameMerchant: sameMerchant(n.merchant, p.merchant), days })
    }
    combos.sort((a, b) => Number(b.sameMerchant) - Number(a.sameMerchant) || a.days - b.days
      || a.negative.date.localeCompare(b.negative.date) || a.negative.id.localeCompare(b.negative.id) || a.positive.id.localeCompare(b.positive.id))
    const used = new Set<string>()
    for (const c of combos) {
      if (used.has(c.negative.id) || used.has(c.positive.id)) continue
      used.add(c.negative.id); used.add(c.positive.id)
      if (!opts.inScope || opts.inScope(c.negative) || opts.inScope(c.positive)) out.push(c)
    }
  }
  return out.sort((a, b) => Number(b.sameMerchant) - Number(a.sameMerchant) || a.negative.date.localeCompare(b.negative.date))
}
