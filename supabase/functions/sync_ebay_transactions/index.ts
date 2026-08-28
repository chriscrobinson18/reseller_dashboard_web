// sync_ebay_transactions v20
// Fetches eBay Finances API transactions and upserts into `transactions`.
//
// Invocation modes (from request body):
//   { user_id, full_backfill: true }  → 2-year backfill in 90-day chunks (from ebay_oauth_callback or cron)
//   { user_id }                        → incremental from last_sync_at - 1h (from cron)
//   {}                                 → reads user from Bearer JWT (from Settings UI)
//
// Transaction mapping:
//   SALE        → payout + commissions_fees per marketplaceFees[]
//   SHIPPING_LABEL → shipping_postage
//   REFUND      → payout (auto-tagged returns_allowances if matching SALE found by orderId)
//   NON_SALE_CHARGE → commissions_fees (advertising if "promoted")
//   ADJUSTMENT  → shipping_postage (if shipping keyword) or other_expense
//   TRANSFER    → skipped
//
// Dedup key: csv_transaction_id = "ebay_api_<transactionId>" (or "_fee_<feeType>" for fees)
// Settlement grouping: csv_group_id = payoutId

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const EBAY_CLIENT_ID = Deno.env.get('EBAY_CLIENT_ID')!
const EBAY_CLIENT_SECRET = Deno.env.get('EBAY_CLIENT_SECRET')!
const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.finances https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'
const BATCH = 500

const isSandbox = Deno.env.get('EBAY_ENV') === 'sandbox'
const EBAY_TOKEN_URL = isSandbox
  ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
  : 'https://api.ebay.com/identity/v1/oauth2/token'
// Finances API uses apiz.ebay.com; Fulfillment API uses api.ebay.com
const EBAY_FINANCES_BASE = isSandbox
  ? 'https://apiz.sandbox.ebay.com'
  : 'https://apiz.ebay.com'
const EBAY_FULFILLMENT_BASE = isSandbox
  ? 'https://api.sandbox.ebay.com'
  : 'https://api.ebay.com'

async function refreshAccessToken(
  refreshToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const creds = btoa(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`)
  const resp = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: EBAY_SCOPE,
    }).toString(),
  })
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status} ${await resp.text()}`)
  return resp.json()
}

// Fetch all transactions in a single ≤90-day window using offset pagination.
async function fetchWindow(accessToken: string, from: Date, to: Date): Promise<any[]> {
  const filter = `transactionDate:[${from.toISOString()}..${to.toISOString()}]`
  const allTxs: any[] = []
  let offset = 0
  const limit = 1000

  while (true) {
    const url = new URL(`${EBAY_FINANCES_BASE}/sell/finances/v1/transaction`)
    url.searchParams.set('filter', filter)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))

    const resp = await fetchWithTimeout(url.toString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })
    if (!resp.ok) throw new Error(`eBay API ${resp.status}: ${await resp.text()}`)

    let data: any
    try {
      data = await resp.json()
    } catch {
      console.error(`fetchWindow: empty/invalid JSON at offset=${offset}, stopping pagination`)
      break
    }
    const txs: any[] = data.transactions ?? []
    allTxs.push(...txs)

    const total: number = data.total ?? 0
    offset += limit
    if (offset >= total || txs.length === 0) break
  }
  return allTxs
}

// Wraps fetch with an AbortController timeout. Prevents a hanging eBay API
// connection from blocking the edge function until the 150s hard limit.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Fetch order details from Fulfillment API to get item titles and prices.
// Fetches all orders in parallel with a per-request timeout so a slow/hanging
// eBay response can't stall the whole sync.
async function fetchOrderDetails(
  accessToken: string,
  orderIds: string[],
): Promise<Map<string, Map<string, { title?: string; price?: number }>>> {
  // Map<orderId, Map<lineItemId, { title?, price? }>>
  const details = new Map<string, Map<string, { title?: string; price?: number }>>()

  console.log(`fetchOrderDetails: fetching ${orderIds.length} orders in parallel`)

  const results = await Promise.allSettled(
    orderIds.map(async (orderId) => {
      const url = `${EBAY_FULFILLMENT_BASE}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`
      const resp = await fetchWithTimeout(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })
      if (!resp.ok) {
        const body = await resp.text()
        console.error(`Fulfillment API ${resp.status} for order ${orderId}: ${body.slice(0, 200)}`)
        return null
      }
      const order = await resp.json()
      return { orderId, order }
    })
  )

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Fulfillment fetch error:', result.reason?.message ?? result.reason)
      continue
    }
    if (!result.value) continue
    const { orderId, order } = result.value
    const lineItems = new Map<string, { title?: string; price?: number }>()
    for (const li of (order.lineItems ?? [])) {
      const price = li.lineItemCost?.value != null
        ? parseFloat(li.lineItemCost.value)
        : undefined
      lineItems.set(li.lineItemId, { title: li.title ?? undefined, price })
    }
    if (lineItems.size > 0) details.set(orderId, lineItems)
    else console.warn(`Fulfillment order ${orderId}: no lineItems in response`)
  }

  console.log(`fetchOrderDetails done: ${details.size}/${orderIds.length} orders with line items`)
  return details
}

// Fetch all payouts in a date range.
async function fetchPayouts(accessToken: string, from: Date, to: Date): Promise<any[]> {
  const filter = `payoutDate:[${from.toISOString()}..${to.toISOString()}]`
  const allPayouts: any[] = []
  let offset = 0
  const limit = 200

  while (true) {
    const url = new URL(`${EBAY_FINANCES_BASE}/sell/finances/v1/payout`)
    url.searchParams.set('filter', filter)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))

    const resp = await fetchWithTimeout(url.toString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })
    if (!resp.ok) {
      console.error(`Payouts API ${resp.status}: ${await resp.text()}`)
      break // non-fatal — payout matching is best-effort
    }

    let data: any
    try {
      data = await resp.json()
    } catch {
      console.error(`fetchPayouts: empty/invalid JSON at offset=${offset}, stopping pagination`)
      break
    }
    const payouts: any[] = data.payouts ?? []
    allPayouts.push(...payouts)

    const total: number = data.total ?? 0
    offset += limit
    if (offset >= total || payouts.length === 0) break
  }
  return allPayouts
}

function feeTypeToMerchant(feeType: string): string {
  if (feeType.startsWith('FINAL_VALUE_FEE')) return 'eBay Final Value Fee'
  if (feeType.includes('PROMOTED') || feeType.includes('AD_FEE')) return 'eBay Promoted Listing Fee'
  if (feeType.includes('REGULATORY')) return 'eBay Regulatory Fee'
  return `eBay ${feeType.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}`
}

// Map one eBay Finances API transaction to one or more `transactions` table rows.
function mapTransaction(tx: any, userId: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  const date: string | undefined = (tx.transactionDate as string)?.slice(0, 10)
  if (!date) return rows

  const amount = parseFloat(tx.amount?.value ?? '0')
  const payoutId: string | null = tx.payoutId ?? null
  const orderId: string | null = tx.orderId ?? null

  const base: Record<string, unknown> = {
    user_id: userId,
    date,
    type: 'other',
    source: 'ebay_api',
    platform: 'ebay',
    record_type: 'transaction',
    csv_group_id: payoutId,
    notes: orderId,
    gross_amount: null,
    parent_settlement_id: null,
  }

  switch (tx.transactionType) {
    case 'SALE': {
      // Finances API doesn't include item titles; merchant is updated
      // later by Fulfillment API title lookup if available.
      rows.push({
        ...base,
        amount,
        gross_amount: amount,
        merchant: `eBay Order ${tx.orderId ?? tx.transactionId}`,
        schedule_c_category: 'payout',
        csv_transaction_id: `ebay_api_${tx.transactionId}`,
      })
      let feeIdx = 0
      for (const item of (tx.orderLineItems ?? []) as any[]) {
        for (const fee of (item.marketplaceFees ?? []) as any[]) {
          const feeAmt = parseFloat(fee.amount?.value ?? '0')
          if (feeAmt === 0) continue
          const isAd = (fee.feeType as string)?.includes('PROMOTED') || (fee.feeType as string)?.includes('AD_FEE')
          rows.push({
            ...base,
            amount: -feeAmt, // expense — negate positive eBay fee amount
            merchant: feeTypeToMerchant(fee.feeType ?? ''),
            schedule_c_category: isAd ? 'advertising' : 'commissions_fees',
            csv_transaction_id: `ebay_api_${tx.transactionId}_fee_${feeIdx++}_${fee.feeType}`,
          })
        }
      }
      break
    }
    case 'SHIPPING_LABEL': {
      // Shipping labels have no top-level orderId; extract it from references[] if present
      const shipRefOrderId: string | null =
        (tx.references ?? []).find((r: any) => r.referenceType === 'ORDER_ID')?.referenceId ?? null
      rows.push({
        ...base,
        notes: shipRefOrderId ?? orderId, // override base.notes with the referenced order ID
        amount: -amount, // expense — negate positive eBay amount
        merchant: 'eBay Shipping Label',
        schedule_c_category: 'shipping_postage',
        csv_transaction_id: `ebay_api_${tx.transactionId}`,
      })
      break
    }
    case 'REFUND': {
      const title: string = tx.orderLineItems?.[0]?.title ?? 'eBay Refund'
      rows.push({
        ...base,
        amount: -amount, // debit — money back to buyer, negate positive eBay amount
        merchant: title.slice(0, 200),
        // starts as 'payout'; autoLinkRefund re-tags to 'returns_allowances' after upsert
        schedule_c_category: 'payout',
        csv_transaction_id: `ebay_api_${tx.transactionId}`,
      })
      break
    }
    case 'NON_SALE_CHARGE': {
      const memo: string = tx.transactionMemo ?? ''
      const isAd = memo.toLowerCase().includes('promoted')
      // Ad fees have no top-level orderId; extract it from references[] instead
      const refOrderId: string | null =
        (tx.references ?? []).find((r: any) => r.referenceType === 'ORDER_ID')?.referenceId ?? null
      rows.push({
        ...base,
        notes: refOrderId ?? orderId, // override base.notes with the referenced order ID
        amount: -amount, // expense — negate positive eBay amount
        merchant: memo.slice(0, 100) || 'eBay Charge',
        schedule_c_category: isAd ? 'advertising' : 'commissions_fees',
        csv_transaction_id: `ebay_api_${tx.transactionId}`,
      })
      break
    }
    case 'ADJUSTMENT': {
      const memo: string = tx.transactionMemo ?? ''
      const isShipping = /shipping|label/i.test(memo)
      rows.push({
        ...base,
        amount: -amount, // expense — negate positive eBay amount
        merchant: memo.slice(0, 100) || 'eBay Adjustment',
        schedule_c_category: isShipping ? 'shipping_postage' : 'other_expense',
        csv_transaction_id: `ebay_api_${tx.transactionId}`,
      })
      break
    }
    case 'TRANSFER':
    default:
      break // skip
  }
  return rows
}

// Map one eBay SALE transaction to one or more `sales` table rows.
// One row per orderLineItem — multi-item orders create multiple sales.
function mapSaleRows(tx: any, userId: string): Record<string, unknown>[] {
  if (tx.transactionType !== 'SALE') return []

  const items: any[] = tx.orderLineItems ?? []
  if (items.length === 0) return []

  const orderId: string | null = tx.orderId ?? null
  if (!orderId) return []

  const totalAmount = parseFloat(tx.amount?.value ?? '0')
  const soldAt = tx.transactionDate ?? new Date().toISOString()

  // Total fees across all line items (for single-item shortcut)
  const totalFees = items.reduce((sum: number, item: any) => {
    return sum + (item.marketplaceFees ?? []).reduce((s: number, f: any) => {
      return s + Math.abs(parseFloat(f.amount?.value ?? '0'))
    }, 0)
  }, 0)

  return items.map((item: any) => {
    const title: string = item.title?.slice(0, 200) ?? 'eBay Sale'
    const lineItemId: string = item.lineItemId ?? '0'

    // Per-item fees (stored as negative; we want positive)
    const fees = (item.marketplaceFees ?? []).reduce((sum: number, f: any) => {
      return sum + Math.abs(parseFloat(f.amount?.value ?? '0'))
    }, 0)

    // Initial price estimate; overridden later by Fulfillment API lineItemCost when available.
    // For single-item: reconstruct from net payout + fees.
    // For multi-item: divide evenly (Fulfillment API will correct per-item prices).
    let salePrice: number
    if (items.length === 1) {
      salePrice = totalAmount + totalFees
    } else {
      salePrice = (totalAmount + totalFees) / items.length
    }

    return {
      user_id: userId,
      item_name: title,
      platform: 'ebay',
      source: 'ebay_api',
      quantity: 1,
      sale_price: salePrice,
      fees,
      net_payout: salePrice - fees,
      external_order_id: `${orderId}_${lineItemId}`,
      sold_at: soldAt,
      inventory_status: 'ok',
      return_status: 'none',
      refunded_quantity: 0,
    }
  })
}

// Auto-link a REFUND to its matching SALE transaction by orderId.
// Tags the refund as 'returns_allowances' and copies related_sale_id from the SALE row.
// If no matching SALE found, leaves the refund as 'payout' for manual reconciliation
// via ReconcileReturnModal.
async function autoLinkRefund(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  tx: any,
): Promise<void> {
  if (!tx.orderId) return

  const { data: saleTx, error: queryErr } = await supabase
    .from('transactions')
    .select('related_sale_id')
    .eq('user_id', userId)
    .eq('notes', tx.orderId)
    .eq('schedule_c_category', 'payout')
    .eq('source', 'ebay_api')
    .maybeSingle()

  if (queryErr) {
    console.error(`autoLinkRefund query error for order ${tx.orderId}:`, queryErr)
    return
  }
  if (!saleTx) return // no matching sale; leave refund as 'payout' for manual reconciliation

  await supabase
    .from('transactions')
    .update({
      schedule_c_category: 'returns_allowances',
      related_sale_id: saleTx.related_sale_id,
    })
    .eq('user_id', userId)
    .eq('csv_transaction_id', `ebay_api_${tx.transactionId}`)
}

// Match eBay payouts against Plaid bank deposits and tag as 'transfer'.
// Prevents double-counting revenue when both eBay API and Plaid import the same money.
async function autoTagPlaidDeposits(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  payouts: any[],
): Promise<number> {
  let tagged = 0
  for (const p of payouts) {
    if (p.payoutStatus !== 'SUCCEEDED' && p.payoutStatus !== 'SENT') continue

    const payoutAmount = parseFloat(p.amount?.value ?? '0')
    if (payoutAmount <= 0) continue

    const payoutDate = p.payoutDate?.slice(0, 10)
    if (!payoutDate) continue

    // Find Plaid transactions matching this payout: same amount (to the cent),
    // within +/- 2 days, not already tagged as transfer.
    const dateFrom = new Date(new Date(payoutDate).getTime() - 2 * 86400000)
      .toISOString().slice(0, 10)
    const dateTo = new Date(new Date(payoutDate).getTime() + 2 * 86400000)
      .toISOString().slice(0, 10)

    const { data: matches, error } = await supabase
      .from('transactions')
      .select('id, amount')
      .eq('user_id', userId)
      .eq('source', 'plaid')
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .neq('schedule_c_category', 'transfer')

    if (error) {
      console.error('Plaid match query error:', error)
      continue
    }

    // Find exact amount match (within 1 cent)
    const match = (matches ?? []).find(
      m => Math.abs(Math.abs(m.amount) - payoutAmount) < 0.01
    )
    if (!match) continue

    const { error: updateErr } = await supabase
      .from('transactions')
      .update({
        schedule_c_category: 'transfer',
        notes: `eBay Payout ${p.payoutId}`,
      })
      .eq('id', match.id)

    if (updateErr) {
      console.error('Plaid tag update error:', updateErr)
    } else {
      tagged++
      console.log(`Tagged Plaid tx ${match.id} as transfer (eBay Payout ${p.payoutId}, $${payoutAmount})`)
    }
  }
  return tagged
}

async function syncForUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  fullBackfill: boolean,
): Promise<{ windows: number; imported: number; salesCreated: number; plaidTagged: number }> {
  const { data: tokenRow, error: tokenErr } = await supabase
    .from('ebay_tokens')
    .select('*')
    .eq('user_id', userId)
    .single()
  if (tokenErr || !tokenRow) throw new Error('No eBay connection for this user')

  let accessToken: string = tokenRow.access_token
  const expiry = new Date(tokenRow.token_expiry)
  if (expiry.getTime() - Date.now() < 10 * 60 * 1000) {
    console.log('Refreshing eBay access token...')
    const refreshed = await refreshAccessToken(tokenRow.refresh_token)
    accessToken = refreshed.access_token
    await supabase.from('ebay_tokens').update({
      access_token: accessToken,
      token_expiry: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    }).eq('user_id', userId)
  }

  const now = new Date()
  const windows: Array<{ from: Date; to: Date }> = []

  if (fullBackfill) {
    // Chunk 2 years into 90-day windows, oldest-first
    // NOTE: if the real API enforces a hard 90-day lookback limit (test this!),
    // change twoYearsAgo to: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const twoYearsAgo = new Date(now)
    twoYearsAgo.setFullYear(now.getFullYear() - 2)

    let windowEnd = new Date(now)
    while (windowEnd > twoYearsAgo) {
      const windowStart = new Date(windowEnd.getTime() - 90 * 24 * 60 * 60 * 1000)
      if (windowStart < twoYearsAgo) windowStart.setTime(twoYearsAgo.getTime())
      windows.unshift({ from: windowStart, to: new Date(windowEnd) })
      windowEnd = new Date(windowEnd.getTime() - 90 * 24 * 60 * 60 * 1000)
    }
  } else {
    windows.push({ from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), to: now })
  }

  let totalImported = 0
  const refundTxs: any[] = []
  const allSaleRows: Record<string, unknown>[] = []

  for (const w of windows) {
    console.log(`Fetching ${w.from.toISOString().slice(0,10)} → ${w.to.toISOString().slice(0,10)}`)
    const txs = await fetchWindow(accessToken, w.from, w.to)
    const rows: Record<string, unknown>[] = []

    for (const tx of txs) {
      rows.push(...mapTransaction(tx, userId))
      if (tx.transactionType === 'REFUND' && tx.orderId) refundTxs.push(tx)
      allSaleRows.push(...mapSaleRows(tx, userId))
    }

    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await supabase
        .from('transactions')
        .upsert(rows.slice(i, i + BATCH), { onConflict: 'user_id,csv_transaction_id', ignoreDuplicates: true })
      if (error) console.error('Upsert error:', error)
    }
    totalImported += rows.length
  }

  // Fetch item titles and prices from Fulfillment API (best-effort)
  const orderIds = [...new Set(allSaleRows.map(r => {
    const ext = r.external_order_id as string
    return ext.split('_')[0] // strip lineItemId suffix
  }))]
  if (orderIds.length > 0) {
    const detailMap = await fetchOrderDetails(accessToken, orderIds)
    for (const row of allSaleRows) {
      const ext = row.external_order_id as string
      const [oid, lid] = ext.split('_')
      const orderDetails = detailMap.get(oid)
      if (orderDetails) {
        const li = orderDetails.get(lid) ?? orderDetails.values().next().value
        if (li?.title) row.item_name = li.title.slice(0, 200)
        if (li?.price != null) {
          row.sale_price = li.price
          row.net_payout = li.price - (row.fees as number)
        }
      }
    }
    console.log(`Fetched details for ${detailMap.size}/${orderIds.length} orders`)
  }

  // Upsert eBay API sales rows (per-item).
  // Uses default merge (not ignoreDuplicates) so re-syncs update
  // titles and corrected prices on existing rows.
  let totalSalesCreated = 0
  for (let i = 0; i < allSaleRows.length; i += BATCH) {
    const { error, count } = await supabase
      .from('sales')
      .upsert(allSaleRows.slice(i, i + BATCH), {
        onConflict: 'user_id,external_order_id',
        count: 'exact',
      })
    if (error) console.error('Sales upsert error:', error)
    else totalSalesCreated += count ?? 0
  }
  console.log(`Sales rows upserted: ${totalSalesCreated}`)

  // Auto-link all collected refunds after all windows upserted (so SALE rows exist)
  for (const tx of refundTxs) {
    await autoLinkRefund(supabase, userId, tx)
  }

  // Auto-tag Plaid deposits matching eBay payouts
  const syncFrom = windows[0]?.from ?? new Date()
  const syncTo = windows[windows.length - 1]?.to ?? new Date()
  const payouts = await fetchPayouts(accessToken, syncFrom, syncTo)
  const plaidTagged = await autoTagPlaidDeposits(supabase, userId, payouts)
  if (plaidTagged > 0) console.log(`Auto-tagged ${plaidTagged} Plaid deposits as transfer`)

  await supabase.from('ebay_tokens').update({ last_sync_at: now.toISOString() }).eq('user_id', userId)
  console.log(`Done: ${totalImported} rows, ${windows.length} windows`)
  return { windows: windows.length, imported: totalImported, salesCreated: totalSalesCreated, plaidTagged }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const body = await req.json().catch(() => ({}))
    const { user_id, full_backfill = false } = body as { user_id?: string; full_backfill?: boolean }

    let targetUserId: string
    if (user_id) {
      // Called from cron or ebay_oauth_callback — must use service-role key
      const authHeader = req.headers.get('Authorization') ?? ''
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      if (!authHeader.includes(serviceKey)) {
        return json(401, { error: 'Service-role key required when passing user_id' })
      }
      targetUserId = user_id
    } else {
      // Called from UI with user's JWT
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return json(401, { error: 'Missing Authorization header' })
      const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
      if (error || !user) return json(401, { error: 'Unauthorized' })
      targetUserId = user.id
    }

    const result = await syncForUser(supabase, targetUserId, full_backfill)
    return json(200, { success: true, ...result })
  } catch (err: any) {
    console.error('sync_ebay_transactions error:', err)
    return json(500, { error: err.message ?? String(err) })
  }
})
