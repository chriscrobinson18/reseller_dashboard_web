import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { Transaction, Sale } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// CSV return reconciliation — detects refund + return-shipping rows already
// sitting in imported (source='csv_import') transactions and matches them to
// an inventory-linked sale by external_order_id, so they can be routed through
// record_return (re-tagged, not duplicated) and actually restore FIFO cost
// basis. See docs/superpowers/specs/2026-07-10-returns-design.md "Proposed:
// the CSV reconciliation layer" and
// docs/superpowers/specs/2026-08-27-csv-return-reconciliation-design.md.
//
// This is detection only — nothing here mutates anything. Applying a
// candidate goes through the same `recordReturn` mutation the manual
// ProcessReturnModal uses (see ReconcileReturnModal.tsx).
// ─────────────────────────────────────────────────────────────────────────────

export interface CSVReturnCandidate {
  /** The order ref both sides were grouped by — `transactions.notes`, matched against `sales.external_order_id`. */
  orderRef: string
  /** The negative, uncategorized-as-refund-yet payout row — the buyer's refund. */
  refundTransaction: Transaction
  /**
   * Best-guess return-shipping label row from the same order, or null if none
   * qualified. Heuristic (no platform reliably marks return vs. outbound
   * labels in the categories this app assigns on import): the earliest
   * `shipping_postage` row in the group dated on/after the refund — an
   * outbound label is bought at sale time, before any refund exists.
   */
  shippingCandidate: Transaction | null
  /**
   * Inventory-linked (`item_id` set), not-fully-returned, non-trade sales
   * sharing this order ref. Exactly one is the common case; the review UI
   * lets the user pick among 2+; 0 means "unmatched" (nothing to apply to).
   */
  candidateSales: Sale[]
}

/**
 * Pure matching function — separated from the fetch so it's unit-testable
 * without a live Supabase connection (no spec exists yet; see TASKS.md).
 */
export function buildCSVReturnCandidates(csvRows: Transaction[], sales: Sale[]): CSVReturnCandidate[] {
  const byRef = new Map<string, Transaction[]>()
  for (const t of csvRows) {
    const ref = t.notes
    if (!ref || ref === '--') continue
    const arr = byRef.get(ref) ?? []
    arr.push(t)
    byRef.set(ref, arr)
  }

  const salesByRef = new Map<string, Sale[]>()
  for (const s of sales) {
    if (!s.external_order_id) continue
    if (!s.item_id) continue // unlinked CSV-synced sales — no FIFO to restore, out of scope here
    if (s.deleted_at) continue
    if (s.trade_id) continue // reversed via the trade, not per-leg
    if (s.return_status === 'full') continue // nothing left to return
    const arr = salesByRef.get(s.external_order_id) ?? []
    arr.push(s)
    salesByRef.set(s.external_order_id, arr)
  }

  const candidates: CSVReturnCandidate[] = []
  for (const [ref, txs] of byRef) {
    const refunds = txs.filter(t => t.schedule_c_category === 'payout' && t.amount < 0)
    if (refunds.length === 0) continue

    // Shared pool so two refunds in the same group don't both claim the same
    // shipping row — first (earliest-dated) refund gets first pick.
    const shippingPool = txs.filter(t => t.schedule_c_category === 'shipping_postage')
    const sortedRefunds = [...refunds].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)

    for (const refundTx of sortedRefunds) {
      const eligible = shippingPool
        .filter(s => s.date >= refundTx.date)
        .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
      const shippingCandidate = eligible[0] ?? null
      if (shippingCandidate) {
        const idx = shippingPool.indexOf(shippingCandidate)
        shippingPool.splice(idx, 1)
      }
      candidates.push({
        orderRef: ref,
        refundTransaction: refundTx,
        shippingCandidate,
        candidateSales: salesByRef.get(ref) ?? [],
      })
    }
  }
  return candidates
}

/** Fetches the raw rows and runs `buildCSVReturnCandidates`. */
export function useCSVReturnCandidates(platform: 'ebay' | 'amazon') {
  return useQuery({
    queryKey: ['csv-return-candidates', platform],
    queryFn: async (): Promise<CSVReturnCandidate[]> => {
      const { data: csvRows, error: txErr } = await supabase
        .from('transactions')
        .select('*')
        .eq('source', 'csv_import')
        .eq('platform', platform)
        .is('related_sale_id', null)
        .in('schedule_c_category', ['payout', 'shipping_postage'])
        .not('notes', 'is', null)
      if (txErr) throw txErr

      const { data: sales, error: saleErr } = await supabase
        .from('sales')
        .select('*')
        .eq('platform', platform)
        .not('item_id', 'is', null)
        .not('external_order_id', 'is', null)
      if (saleErr) throw saleErr

      return buildCSVReturnCandidates((csvRows ?? []) as Transaction[], (sales ?? []) as Sale[])
    },
  })
}
