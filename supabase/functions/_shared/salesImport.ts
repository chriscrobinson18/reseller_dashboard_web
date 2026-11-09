// Shared "safe upsert" for marketplace order imports that write straight to
// `sales` (eBay Order Earnings via import_marketplace_csv, TCGplayer via
// import_tcgplayer_orders). Added 2026-11-09.
//
// Re-importing a platform report must BACKFILL, never clobber:
//   - New orders (no sale with that external_order_id) are inserted in full.
//   - Existing live sales get only the platform-sourced money/description
//     fields refreshed (price, fees, fee breakdown, shipping, discount, net,
//     date, name, qty). The platform report is authoritative for those.
//   - Refund fields (refunded_amount, return_status) are refreshed only when
//     the sale has no `returns` row; once a return was processed in-app, the
//     app owns them.
//   - Soft-deleted sales are skipped: a re-import never un-deletes.
//   - inventory_status, refunded_quantity, item_id, bundle/trade links and
//     deleted_at are never written on an existing sale.
//
// Before this, both importers upserted the full row on (user_id,
// external_order_id), which reset deleted_at to null, inventory_status to
// 'ok' and refunded_quantity to 0 on every re-import.

/** Fields a platform report may overwrite on an existing sale. */
export const IMPORT_REFRESH_FIELDS = [
  'platform', 'item_name', 'quantity', 'sale_price', 'fees', 'fee_breakdown',
  'shipping_cost', 'shipping_charged', 'discount', 'net_payout', 'sold_at',
] as const

/** Refreshed only when the sale has no in-app `returns` row. */
export const IMPORT_REFUND_FIELDS = ['refunded_amount', 'return_status'] as const

export type ImportResult = {
  inserted: number
  updated: number
  skipped_deleted: number
  failed: number
}

type Row = Record<string, unknown> & { external_order_id: string }

function pick(row: Row, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) if (f in row) out[f] = row[f]
  return out
}

/**
 * Upsert batch `rows` (full insert payloads, one per order) for `userId`.
 * `supabase` must be a service-role client; every query is scoped by userId.
 */
export async function upsertImportedSales(
  supabase: any,
  userId: string,
  rows: Row[],
  batchSize = 200,
): Promise<ImportResult> {
  const result: ImportResult = { inserted: 0, updated: 0, skipped_deleted: 0, failed: 0 }

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const ids = batch.map(r => r.external_order_id)

    const { data: existing, error: exErr } = await supabase
      .from('sales')
      .select('id, external_order_id, deleted_at')
      .eq('user_id', userId)
      .in('external_order_id', ids)
    if (exErr) {
      console.error('Existing-sales lookup error:', exErr)
      result.failed += batch.length
      continue
    }
    const byOrder = new Map<string, { id: string; deleted_at: string | null }>()
    for (const s of existing ?? []) byOrder.set(s.external_order_id, s)

    const liveIds = [...byOrder.values()].filter(s => !s.deleted_at).map(s => s.id)
    const withReturns = new Set<string>()
    if (liveIds.length) {
      const { data: rets, error: rErr } = await supabase
        .from('returns').select('sale_id').in('sale_id', liveIds)
      if (rErr) {
        console.error('Returns lookup error:', rErr)
        result.failed += batch.length
        continue
      }
      for (const r of rets ?? []) withReturns.add(r.sale_id)
    }

    const inserts: Row[] = []
    // Two update groups with different column sets: PostgREST fills keys
    // missing from an object with null, so each upsert call must carry rows
    // with an identical key set.
    const updFull: Record<string, unknown>[] = []
    const updNoRefund: Record<string, unknown>[] = []

    for (const row of batch) {
      const ex = byOrder.get(row.external_order_id)
      if (!ex) { inserts.push(row); continue }
      if (ex.deleted_at) { result.skipped_deleted++; continue }
      const base = { user_id: userId, external_order_id: row.external_order_id, ...pick(row, IMPORT_REFRESH_FIELDS) }
      if (withReturns.has(ex.id)) updNoRefund.push(base)
      else updFull.push({ ...base, ...pick(row, IMPORT_REFUND_FIELDS) })
    }

    if (inserts.length) {
      const { error } = await supabase.from('sales').insert(inserts)
      if (error) { console.error('Sales insert error:', error); result.failed += inserts.length }
      else result.inserted += inserts.length
    }
    for (const group of [updFull, updNoRefund]) {
      if (!group.length) continue
      const { error } = await supabase.from('sales')
        .upsert(group, { onConflict: 'user_id,external_order_id' })
      if (error) { console.error('Sales update error:', error); result.failed += group.length }
      else result.updated += group.length
    }
  }
  return result
}
