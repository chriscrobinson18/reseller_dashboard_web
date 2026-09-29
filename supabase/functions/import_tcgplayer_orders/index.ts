// supabase/functions/import_tcgplayer_orders/index.ts
// v1 — Import TCGPlayer orders from Tampermonkey export JSON.
// Upserts directly into `sales` table (same as eBay Order Earnings path).
// Skips Canceled orders. Maps refundStatus → return_status.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const BATCH = 200

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

type TcgOrder = {
  orderNumber: string
  orderDate: string       // ISO 8601 e.g. "2026-09-26T01:25:13.767Z"
  orderStatus: string     // "Completed - Paid" | "Ready to Ship" | "Canceled"
  productAmount: number
  shippingAmount: number
  grossAmount: number
  feeAmount: number
  netAmount: number
  refundStatus: string    // "" | "FullRefund" | "PartialRefund"
  refunds: unknown[]
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return json(401, { error: 'Unauthorized' })

    const body = await req.json()
    const orders: TcgOrder[] = body.orders
    if (!Array.isArray(orders)) return json(400, { error: 'Body must be { orders: TcgOrder[] }' })

    const salesRows: Record<string, unknown>[] = []
    let skipped = 0

    for (const o of orders) {
      if (o.orderStatus === 'Canceled') { skipped++; continue }

      const rs = (o.refundStatus ?? '').toLowerCase()
      const returnStatus = rs.includes('full') ? 'full' : rs.includes('partial') ? 'partial' : 'none'

      salesRows.push({
        user_id: user.id,
        platform: 'tcgplayer',
        source: 'tcgplayer',
        external_order_id: o.orderNumber,
        sale_price: o.productAmount,
        shipping_cost: o.shippingAmount,
        fees: o.feeAmount,
        net_payout: o.netAmount,
        return_status: returnStatus,
        sold_at: o.orderDate.slice(0, 10),
        inventory_status: 'ok',
        refunded_quantity: 0,
        deleted_at: null,
      })
    }

    let upserted = 0
    for (let i = 0; i < salesRows.length; i += BATCH) {
      const batch = salesRows.slice(i, i + BATCH)
      const { error } = await supabase
        .from('sales')
        .upsert(batch, { onConflict: 'user_id,external_order_id' })
      if (error) {
        console.error('Sales upsert error:', error)
      } else {
        upserted += batch.length
      }
    }

    return json(200, { platform: 'tcgplayer', sales_upserted: upserted, skipped })
  } catch (error: unknown) {
    console.error('Import error:', error)
    return json(500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
})
