// sync_csv_orders_to_sales v6 (2026-11-10)
// Fix: shipping_postage rows are summed signed (a positive postage refund /
//      credit now reduces shipping_cost; v1–v5 added it as more postage).
//      Per-order math moved to _shared/csvOrderAggregate.ts (unit-tested).
// Prior: sync_csv_orders_to_sales v5 (2026-11-09)
// Re-import safe: writes go through _shared/salesImport.ts (the same path as
// eBay Order Earnings and TCGplayer). Re-running the sync after an Amazon /
// Mercari CSV upload now:
//   - inserts new orders in full;
//   - refreshes only money/description fields on existing live sales;
//   - refreshes return_status only when no in-app `returns` row exists;
//   - NEVER un-deletes a soft-deleted sale (v4 cleared deleted_at);
//   - NEVER resets inventory_status / refunded_quantity (v4 wrote 'ok' / 0);
//   - NEVER soft-deletes sales whose order is missing from the CSV rows
//     (v4 did); they are only counted in `orphans` for review.
// Money semantics are unchanged from v4 (sale_price = gross − refunds).
// Client is now service-role (the shared helper requires it); every query is
// filtered by the caller's user_id.
// Prior: sync_csv_orders_to_sales v4
// Fix: fees use signed arithmetic (entry.fees -= amount) so positive fee reversals
//      (e.g. Amazon DR Refund fee_reversal transactions) reduce fees rather than inflating them.
// Prior: sync_csv_orders_to_sales v3
// Groups csv_import transactions by order ref (notes field) and upserts
// unlinked sales rows. Fixes three mobile bugs:
//   1. shipping_postage rows were unreachable dead code — now included
//   2. duplicate external_order_id crashed mobile — safe Map used here
//   3. return_status used invalid 'none' — writes null per DB constraint
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { upsertImportedSales } from "../_shared/salesImport.ts"
import { aggregateCsvOrders, csvOrderSaleFields, type CsvOrderEntry } from "../_shared/csvOrderAggregate.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

// Map platform string to the sales.source value allowed by the DB constraint:
//   'manual' | 'amazon' | 'ebay' | 'tcgplayer' | 'csv_import' | 'trade'
// Mercari has no dedicated source value — use 'csv_import'.
function sourceForPlatform(platform: string): string {
  if (platform === "ebay" || platform === "amazon") return platform
  return "csv_import"
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) return json(401, { error: "Unauthorized" })

    // Service-role client (as in import_marketplace_csv / import_tcgplayer_orders,
    // and as _shared/salesImport.ts requires); the caller is identified from
    // their JWT and every query below is scoped by user_id.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )
    const token = authHeader.replace(/^Bearer\s+/i, "")
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return json(401, { error: "Unauthorized" })

    const body = await req.json()
    const platform: string = body.platform
    if (!platform) return json(400, { error: "Missing platform" })

    // eBay sales come from Order Earnings import (import_marketplace_csv v19),
    // not from Transaction Report transactions. Skip sync for eBay.
    if (platform === "ebay") {
      return json(200, { created: 0, updated: 0, removed: 0 })
    }

    // ── 1. Fetch all csv_import transactions for this user + platform ─────────
    const { data: rows, error: fetchErr } = await supabase
      .from("transactions")
      .select("id, date, amount, merchant, notes, schedule_c_category, csv_group_id")
      .eq("user_id", user.id)
      .eq("source", "csv_import")
      .eq("platform", platform)
      .not("csv_group_id", "is", null)
      .order("date", { ascending: true })

    if (fetchErr) return json(500, { error: fetchErr.message })

    // ── 2. Group by orderRef (notes field) — _shared/csvOrderAggregate.ts ────
    const orderMap = aggregateCsvOrders(rows ?? [])

    // ── 3. Keep only orders with gross revenue ────────────────────────────────
    const ordersToSync = new Map<string, CsvOrderEntry>()
    for (const [ref, entry] of orderMap) {
      if (entry.grossRevenue > 0) ordersToSync.set(ref, entry)
    }

    if (ordersToSync.size === 0) {
      return json(200, { created: 0, updated: 0, removed: 0 })
    }

    // ── 4. Build one full insert payload per order ───────────────────────────
    const source = sourceForPlatform(platform)
    const rowsOut: (Record<string, unknown> & { external_order_id: string })[] = []
    for (const [ref, entry] of ordersToSync) {
      rowsOut.push({
        user_id: user.id,
        platform,
        source,
        external_order_id: ref,
        item_id: null,
        item_name: entry.productName ?? null,
        quantity: 1,
        ...csvOrderSaleFields(entry),
        sold_at: entry.date,
        // Insert-only: upsertImportedSales never writes these on an existing sale.
        inventory_status: "ok",
        refunded_quantity: 0,
      })
    }

    // ── 5. Safe upsert (insert new, backfill existing, skip deleted) ──────────
    const r = await upsertImportedSales(supabase, user.id, rowsOut)

    // ── 6. Report (never delete) live sales whose order is no longer in the CSV rows
    const { data: existingSales, error: salesErr } = await supabase
      .from("sales")
      .select("external_order_id")
      .eq("user_id", user.id)
      .eq("source", source)
      .eq("platform", platform)
      .is("deleted_at", null)
      .not("external_order_id", "is", null)
    if (salesErr) return json(500, { error: salesErr.message })
    const orphans = (existingSales ?? []).filter(s => !ordersToSync.has(s.external_order_id)).length

    const created = r.inserted, updated = r.updated, removed = 0
    return json(200, { created, updated, removed, skipped_deleted: r.skipped_deleted, failed: r.failed, orphans })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return json(500, { error: msg })
  }
})
