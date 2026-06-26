// plaid_sync_transactions v31
// CORS: handles OPTIONS preflight and returns Access-Control-Allow-Origin on every
// response so the web client (browser) can call this function. iOS native HTTPS
// callers ignore these headers — additive change, no behavioral impact for mobile.
// Settlement classification: sign-aware, precise merchant patterns.
// Positive credits (tx.amount < 0 in Plaid) from marketplace merchants = settlements.
// Negative debits (purchases on eBay/Amazon) are NOT settlements.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { Configuration, PlaidApi, PlaidEnvironments } from "npm:plaid@latest"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[Deno.env.get('PLAID_ENV') || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': Deno.env.get('PLAID_CLIENT_ID'),
      'PLAID-SECRET': Deno.env.get('PLAID_SECRET'),
    },
  },
})

const plaidClient = new PlaidApi(plaidConfig)

const PFC_TO_SCHEDULE_C: Record<string, string> = {
  'TRANSFER_IN':        'transfer',
  'TRANSFER_OUT':       'transfer',
  'INCOME':             'payout',
  'BANK_FEES':          'other_expense',
  'FOOD_AND_DRINK':     'meals',
  'TRAVEL':             'travel',
  'RENT_AND_UTILITIES': 'utilities',
  'PERSONAL_CARE':      'personal',
  'MEDICAL':            'personal',
}

/**
 * Classify a Plaid transaction as a marketplace settlement.
 * Only positive credits (plaidAmount < 0) from known marketplace sources qualify.
 * Purchases/debits on eBay/Amazon are expenses, not settlements.
 *
 * Plaid amount sign convention: positive = debit (money out), negative = credit (money in).
 */
function classifySettlement(
  merchant: string | null,
  plaidAmount: number
): { record_type: string; platform: string; schedule_c_category: string } | null {
  if (!merchant || plaidAmount >= 0) return null

  if (merchant === 'eBay' || /ORIG CO NAME:eBay/i.test(merchant))
    return { record_type: 'settlement', platform: 'ebay', schedule_c_category: 'settlement' }

  if (/REAL TIME TRANSFER.*AMAZON\.COM/i.test(merchant) || /ORIG CO NAME:AMAZON/i.test(merchant))
    return { record_type: 'settlement', platform: 'amazon', schedule_c_category: 'settlement' }

  if (/TCGplayer/i.test(merchant))
    return { record_type: 'settlement', platform: 'tcgplayer', schedule_c_category: 'settlement' }

  if (/Mercari/i.test(merchant))
    return { record_type: 'settlement', platform: 'mercari', schedule_c_category: 'settlement' }

  if (/\bstockx\b/i.test(merchant))
    return { record_type: 'settlement', platform: 'stockx', schedule_c_category: 'settlement' }
  if (/\bgoat\b/i.test(merchant))
    return { record_type: 'settlement', platform: 'goat', schedule_c_category: 'settlement' }
  if (/\bposhmark\b/i.test(merchant))
    return { record_type: 'settlement', platform: 'poshmark', schedule_c_category: 'settlement' }
  if (/\bdepop\b/i.test(merchant))
    return { record_type: 'settlement', platform: 'depop', schedule_c_category: 'settlement' }

  return null
}

function getTransactionType(tx: any): string {
  const cat = tx.category?.[0]?.toLowerCase() || ''
  if (cat.includes('shipping') || cat.includes('transportation')) return 'shipping'
  if (cat.includes('fee') || cat.includes('service')) return 'fee'
  if (cat.includes('shop') || cat.includes('purchase')) return 'inventory'
  return 'other'
}

function buildAccountMap(accounts: any[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const acct of accounts) {
    const label = acct.subtype
      ? `${acct.subtype.charAt(0).toUpperCase() + acct.subtype.slice(1)} ••${acct.mask}`
      : `••${acct.mask}`
    map[acct.account_id] = label
  }
  return map
}

function buildRow(tx: any, userId: string, accountMap: Record<string, string>) {
  const merchant = tx.merchant_name || tx.name
  const settlement = classifySettlement(merchant, tx.amount)
  return {
    user_id: userId,
    plaid_transaction_id: tx.transaction_id,
    date: tx.date,
    amount: -tx.amount,
    merchant,
    type: getTransactionType(tx),
    source: 'plaid',
    account_display: accountMap[tx.account_id] ?? null,
    plaid_category: tx.personal_finance_category?.primary ?? null,
    record_type: settlement?.record_type ?? 'transaction',
    platform: settlement?.platform ?? null,
    ...(settlement ? { schedule_c_category: settlement.schedule_c_category } : {}),
  }
}

const BATCH = 200

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')

    const body = await req.json().catch(() => ({}))
    const filterItemId: string | null = body.item_id ?? null
    const resetCursor: boolean = body.reset_cursor === true

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let query = supabase.from('plaid_items').select('*').eq('user_id', user.id)
    if (filterItemId) query = query.eq('item_id', filterItemId)
    const { data: plaidItems } = await query

    if (!plaidItems?.length) {
      return new Response(
        JSON.stringify({ success: false, error: 'No Plaid accounts connected' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let totalAdded = 0
    let totalModified = 0
    let totalRemoved = 0
    let totalSettlements = 0
    const warnings: string[] = []

    for (const item of plaidItems) {
      try {
        const { data: allAccts } = await supabase
          .from('plaid_accounts')
          .select('account_id, sync_enabled')
          .eq('item_id', item.item_id)

        const enabledSet: Set<string> | null =
          allAccts?.length
            ? new Set((allAccts as any[]).filter((a) => a.sync_enabled).map((a) => a.account_id))
            : null

        if (enabledSet !== null && enabledSet.size === 0) {
          console.log(`All accounts disabled for item ${item.item_id}, skipping`)
          continue
        }

        let cursor: string | null = resetCursor ? null : (item.cursor ?? null)
        let addedTx: any[] = []
        let modifiedTx: any[] = []
        let removedTx: any[] = []
        let accountMap: Record<string, string> = {}
        let hasMore = true

        while (hasMore) {
          const resp = await plaidClient.transactionsSync({
            access_token: item.access_token,
            cursor: cursor ?? undefined,
            options: { include_personal_finance_category: true },
          })

          if (!Object.keys(accountMap).length) {
            accountMap = buildAccountMap(resp.data.accounts)
          }

          const filterFn = enabledSet ? (tx: any) => enabledSet.has(tx.account_id) : () => true

          addedTx    = addedTx.concat(resp.data.added.filter(filterFn))
          modifiedTx = modifiedTx.concat(resp.data.modified.filter(filterFn))
          removedTx  = removedTx.concat(resp.data.removed)
          cursor     = resp.data.next_cursor
          hasMore    = resp.data.has_more

          console.log(`Item ${item.item_id}: +${resp.data.added.length} ~${resp.data.modified.length} -${resp.data.removed.length} hasMore=${hasMore}`)
        }

        if (addedTx.length > 0) {
          const rows = addedTx.map((tx: any) => buildRow(tx, user.id, accountMap))
          const settlements = rows.filter((r) => r.record_type === 'settlement').length
          totalSettlements += settlements
          if (settlements > 0) console.log(`Item ${item.item_id}: ${settlements} settlements detected`)

          for (let i = 0; i < rows.length; i += BATCH) {
            const { error } = await supabase
              .from('transactions')
              .upsert(rows.slice(i, i + BATCH), { onConflict: 'plaid_transaction_id', ignoreDuplicates: true })
            if (error) console.error('Upsert added error:', error)
          }
          for (const [pfc, scheduleC] of Object.entries(PFC_TO_SCHEDULE_C)) {
            await supabase
              .from('transactions')
              .update({ schedule_c_category: scheduleC })
              .eq('user_id', user.id)
              .eq('plaid_category', pfc)
              .eq('record_type', 'transaction')
              .is('schedule_c_category', null)
          }
          totalAdded += addedTx.length
        }

        if (modifiedTx.length > 0) {
          const rows = modifiedTx.map((tx: any) => buildRow(tx, user.id, accountMap))
          for (let i = 0; i < rows.length; i += BATCH) {
            const { error } = await supabase
              .from('transactions')
              .upsert(rows.slice(i, i + BATCH), { onConflict: 'plaid_transaction_id', ignoreDuplicates: false })
            if (error) console.error('Upsert modified error:', error)
          }
          totalModified += modifiedTx.length
        }

        if (removedTx.length > 0) {
          const removedIds = removedTx.map((tx: any) => tx.transaction_id)
          const { data: withReceipts } = await supabase
            .from('transactions')
            .select('receipt_url')
            .in('plaid_transaction_id', removedIds)
            .eq('user_id', user.id)
            .not('receipt_url', 'is', null)
          if (withReceipts?.length) {
            await supabase.storage.from('receipts').remove(withReceipts.map((r: any) => r.receipt_url))
          }
          for (let i = 0; i < removedIds.length; i += BATCH) {
            await supabase.from('transactions').delete()
              .in('plaid_transaction_id', removedIds.slice(i, i + BATCH))
              .eq('user_id', user.id)
          }
          totalRemoved += removedTx.length
        }

        await supabase
          .from('plaid_items')
          .update({ cursor, last_synced_at: new Date().toISOString() })
          .eq('item_id', item.item_id)

        console.log(`Item ${item.item_id} done: +${addedTx.length} ~${modifiedTx.length} -${removedTx.length}`)

      } catch (itemErr: any) {
        const plaidError = itemErr?.response?.data
        const errorCode: string = plaidError?.error_code ?? ''
        if (errorCode === 'PRODUCT_NOT_READY') {
          const msg = 'Transaction history is being prepared by your bank. Please sync again in a few minutes.'
          console.log(`Item ${item.item_id}: PRODUCT_NOT_READY`)
          warnings.push(msg)
        } else {
          console.error(`Error syncing item ${item.item_id}:`, plaidError ?? itemErr?.message ?? itemErr)
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        transactions_added: totalAdded,
        transactions_modified: totalModified,
        transactions_removed: totalRemoved,
        settlements_detected: totalSettlements,
        ...(warnings.length ? { warnings } : {}),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error: any) {
    console.error('Sync error:', error?.response?.data ?? error?.message ?? error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
