// sync_ebay_transactions v1
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
const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.finances https://api.ebay.com/oauth/api_scope/commerce.identity.readonly'
const BATCH = 500

const isSandbox = Deno.env.get('EBAY_ENV') === 'sandbox'
const EBAY_TOKEN_URL = isSandbox
  ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
  : 'https://api.ebay.com/identity/v1/oauth2/token'
const EBAY_API_BASE = isSandbox
  ? 'https://apiz.sandbox.ebay.com'
  : 'https://apiz.ebay.com'

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
    const url = new URL(`${EBAY_API_BASE}/sell/finances/v1/transaction`)
    url.searchParams.set('filter', filter)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))

    const resp = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })
    if (!resp.ok) throw new Error(`eBay API ${resp.status}: ${await resp.text()}`)

    const data = await resp.json()
    const txs: any[] = data.transactions ?? []
    allTxs.push(...txs)

    const total: number = data.total ?? 0
    offset += limit
    if (offset >= total || txs.length === 0) break
  }
  return allTxs
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
      const title: string = tx.orderLineItems?.[0]?.title ?? 'eBay Sale'
      rows.push({
        ...base,
        amount,
        gross_amount: amount,
        merchant: title.slice(0, 200),
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
            amount: feeAmt,
            merchant: feeTypeToMerchant(fee.feeType ?? ''),
            schedule_c_category: isAd ? 'advertising' : 'commissions_fees',
            csv_transaction_id: `ebay_api_${tx.transactionId}_fee_${feeIdx++}_${fee.feeType}`,
          })
        }
      }
      break
    }
    case 'SHIPPING_LABEL':
      rows.push({
        ...base,
        amount,
        merchant: 'eBay Shipping Label',
        schedule_c_category: 'shipping_postage',
        csv_transaction_id: `ebay_api_${tx.transactionId}`,
      })
      break
    case 'REFUND': {
      const title: string = tx.orderLineItems?.[0]?.title ?? 'eBay Refund'
      rows.push({
        ...base,
        amount,
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
      rows.push({
        ...base,
        amount,
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
        amount,
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

async function syncForUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  fullBackfill: boolean,
): Promise<{ windows: number; imported: number }> {
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
    const lastSync = tokenRow.last_sync_at
      ? new Date(new Date(tokenRow.last_sync_at).getTime() - 60 * 60 * 1000)
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    windows.push({ from: lastSync, to: now })
  }

  let totalImported = 0
  const refundTxs: any[] = []

  for (const w of windows) {
    console.log(`Fetching ${w.from.toISOString().slice(0,10)} → ${w.to.toISOString().slice(0,10)}`)
    const txs = await fetchWindow(accessToken, w.from, w.to)
    const rows: Record<string, unknown>[] = []

    for (const tx of txs) {
      rows.push(...mapTransaction(tx, userId))
      if (tx.transactionType === 'REFUND' && tx.orderId) refundTxs.push(tx)
    }

    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await supabase
        .from('transactions')
        .upsert(rows.slice(i, i + BATCH), { onConflict: 'user_id,csv_transaction_id', ignoreDuplicates: true })
      if (error) console.error('Upsert error:', error)
    }
    totalImported += rows.length
  }

  // Auto-link all collected refunds after all windows upserted (so SALE rows exist)
  for (const tx of refundTxs) {
    await autoLinkRefund(supabase, userId, tx)
  }

  await supabase.from('ebay_tokens').update({ last_sync_at: now.toISOString() }).eq('user_id', userId)
  console.log(`Done: ${totalImported} rows, ${windows.length} windows`)
  return { windows: windows.length, imported: totalImported }
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
