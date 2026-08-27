// sync_csv_orders_to_sales v1
// Groups csv_import transactions by order ref (notes field) and upserts
// unlinked sales rows. Fixes three mobile bugs:
//   1. shipping_postage rows were unreachable dead code — now included
//   2. duplicate external_order_id crashed mobile — safe Map used here
//   3. return_status used invalid 'none' — writes null per DB constraint
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

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

const SKIP_CATEGORIES = new Set([
  "transfer", "balance_adjustment", "taxes_licenses", "settlement",
])

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

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return json(401, { error: "Unauthorized" })

    const body = await req.json()
    const platform: string = body.platform
    if (!platform) return json(400, { error: "Missing platform" })

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

    // ── 2. Group by orderRef (notes field) ────────────────────────────────────
    interface OrderEntry {
      grossRevenue: number
      refundedAmount: number
      fees: number
      shippingCost: number
      date: string
      productName: string | null
    }

    const orderMap = new Map<string, OrderEntry>()

    for (const tx of (rows ?? [])) {
      const ref = tx.notes as string | null
      if (!ref || ref === "" || ref === "--") continue
      if (SKIP_CATEGORIES.has(tx.schedule_c_category as string)) continue

      const entry: OrderEntry = orderMap.get(ref) ?? {
        grossRevenue: 0, refundedAmount: 0, fees: 0,
        shippingCost: 0, date: tx.date, productName: null,
      }

      const amount = Number(tx.amount)
      const cat = tx.schedule_c_category as string

      if (cat === "payout") {
        if (amount > 0) {
          entry.grossRevenue += amount
          // Keep the earliest payout date as the sale date
          if (tx.date < entry.date) entry.date = tx.date
          if (!entry.productName && tx.merchant) entry.productName = tx.merchant
        } else {
          entry.refundedAmount += Math.abs(amount)
        }
      } else if (cat === "commissions_fees") {
        entry.fees += Math.abs(amount)
      } else if (cat === "shipping_postage") {
        entry.shippingCost += Math.abs(amount)
      }

      orderMap.set(ref, entry)
    }

    // ── 3. Keep only orders with gross revenue ────────────────────────────────
    const ordersToSync = new Map<string, OrderEntry>()
    for (const [ref, entry] of orderMap) {
      if (entry.grossRevenue > 0) ordersToSync.set(ref, entry)
    }

    if (ordersToSync.size === 0) {
      return json(200, { created: 0, updated: 0, removed: 0 })
    }

    // ── 4. Fetch existing csv-sourced sales for this platform ─────────────────
    const source = sourceForPlatform(platform)
    const { data: existingSales, error: salesErr } = await supabase
      .from("sales")
      .select("id, external_order_id, deleted_at")
      .eq("user_id", user.id)
      .eq("source", source)
      .eq("platform", platform)
      .not("external_order_id", "is", null)

    if (salesErr) return json(500, { error: salesErr.message })

    // Build a safe Map (no crash on duplicate external_order_id)
    const existingMap = new Map<string, { id: string; deleted_at: string | null }>()
    for (const s of (existingSales ?? [])) {
      if (s.external_order_id && !existingMap.has(s.external_order_id)) {
        existingMap.set(s.external_order_id, { id: s.id, deleted_at: s.deleted_at })
      }
    }

    // ── 5. Upsert ─────────────────────────────────────────────────────────────
    let created = 0, updated = 0, removed = 0

    for (const [ref, entry] of ordersToSync) {
      const salePrice = entry.grossRevenue - entry.refundedAmount
      const netPayout = salePrice - entry.fees - entry.shippingCost
      const returnStatus =
        entry.refundedAmount === 0 ? null
        : entry.refundedAmount >= entry.grossRevenue ? "full"
        : "partial"

      const saleData = {
        sale_price: salePrice,
        fees: entry.fees,
        shipping_cost: entry.shippingCost,
        net_payout: netPayout,
        return_status: returnStatus,
        sold_at: entry.date,
        inventory_status: 'ok',
        refunded_quantity: 0,
      }

      const existing = existingMap.get(ref)
      if (existing) {
        // Update (and restore if soft-deleted)
        const updatePayload: Record<string, unknown> = { ...saleData }
        if (existing.deleted_at !== null) updatePayload.deleted_at = null
        const { error } = await supabase
          .from("sales")
          .update(updatePayload)
          .eq("id", existing.id)
        if (error) console.error("Update error:", error.message)
        else updated++
      } else {
        // Insert
        const { error } = await supabase.from("sales").insert({
          user_id: user.id,
          platform,
          source,
          external_order_id: ref,
          item_id: null,
          item_name: entry.productName ?? null,
          quantity: 1,
          ...saleData,
        })
        if (error) console.error("Insert error:", error.message)
        else created++
      }
    }

    // ── 6. Soft-delete orphans (order no longer in CSV) ───────────────────────
    for (const [ref, existing] of existingMap) {
      if (!ordersToSync.has(ref) && existing.deleted_at === null) {
        const { error } = await supabase
          .from("sales")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", existing.id)
        if (error) console.error("Soft-delete error:", error.message)
        else removed++
      }
    }

    return json(200, { created, updated, removed })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return json(500, { error: msg })
  }
})
