// plaid_sync_scheduled v16
// Production-ready scheduled cursor sync (cron, all users).
// Matches plaid_sync_transactions v27 logic exactly.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { Configuration, PlaidApi, PlaidEnvironments } from "npm:plaid@latest"

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
      ? `${acct.subtype.charAt(0).toUpperCase() + acct.subtype.slice(1)} \u2022\u2022${acct.mask}`
      : `\u2022\u2022${acct.mask}`
    map[acct.account_id] = label
  }
  return map
}

const BATCH = 200

async function syncItem(supabase: any, item: any): Promise<{ added: number, modified: number, removed: number }> {
  const { data: allAccts } = await supabase
    .from('plaid_accounts')
    .select('account_id, sync_enabled')
    .eq('item_id', item.item_id)

  const enabledSet: Set<string> | null =
    allAccts?.length
      ? new Set((allAccts as any[]).filter((a: any) => a.sync_enabled).map((a: any) => a.account_id))
      : null

  if (enabledSet !== null && enabledSet.size === 0) {
    console.log(`All accounts disabled for item ${item.item_id}, skipping`)
    return { added: 0, modified: 0, removed: 0 }
  }

  let cursor: string | null = item.cursor ?? null
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
    const rows = addedTx.map((tx: any) => ({
      user_id: item.user_id,
      plaid_transaction_id: tx.transaction_id,
      date: tx.date,
      amount: -tx.amount,
      merchant: tx.merchant_name || tx.name,
      type: getTransactionType(tx),
      source: 'plaid',
      account_display: accountMap[tx.account_id] ?? null,
      plaid_category: tx.personal_finance_category?.primary ?? null,
    }))
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
        .eq('user_id', item.user_id)
        .eq('plaid_category', pfc)
        .is('schedule_c_category', null)
    }
  }

  if (modifiedTx.length > 0) {
    const rows = modifiedTx.map((tx: any) => ({
      user_id: item.user_id,
      plaid_transaction_id: tx.transaction_id,
      date: tx.date,
      amount: -tx.amount,
      merchant: tx.merchant_name || tx.name,
      type: getTransactionType(tx),
      source: 'plaid',
      account_display: accountMap[tx.account_id] ?? null,
      plaid_category: tx.personal_finance_category?.primary ?? null,
    }))
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await supabase
        .from('transactions')
        .upsert(rows.slice(i, i + BATCH), { onConflict: 'plaid_transaction_id', ignoreDuplicates: false })
      if (error) console.error('Upsert modified error:', error)
    }
  }

  if (removedTx.length > 0) {
    const removedIds = removedTx.map((tx: any) => tx.transaction_id)
    const { data: withReceipts } = await supabase
      .from('transactions')
      .select('receipt_url')
      .in('plaid_transaction_id', removedIds)
      .eq('user_id', item.user_id)
      .not('receipt_url', 'is', null)
    if (withReceipts?.length) {
      await supabase.storage.from('receipts').remove(withReceipts.map((r: any) => r.receipt_url))
    }
    for (let i = 0; i < removedIds.length; i += BATCH) {
      await supabase.from('transactions').delete()
        .in('plaid_transaction_id', removedIds.slice(i, i + BATCH))
        .eq('user_id', item.user_id)
    }
  }

  await supabase
    .from('plaid_items')
    .update({ cursor, last_synced_at: new Date().toISOString() })
    .eq('item_id', item.item_id)

  return { added: addedTx.length, modified: modifiedTx.length, removed: removedTx.length }
}

serve(async (_req) => {
  try {
    console.log('Starting scheduled sync...')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: plaidItems, error: fetchError } = await supabase.from('plaid_items').select('*')
    if (fetchError) throw fetchError
    if (!plaidItems?.length) {
      return new Response(JSON.stringify({ success: true, message: 'No items to sync' }), { status: 200 })
    }

    console.log(`Found ${plaidItems.length} item(s)`)

    let totalAdded = 0, totalModified = 0, totalRemoved = 0, itemsProcessed = 0

    for (const item of plaidItems) {
      try {
        const result = await syncItem(supabase, item)
        totalAdded    += result.added
        totalModified += result.modified
        totalRemoved  += result.removed
        itemsProcessed++
        console.log(`Item ${item.item_id} done: +${result.added} ~${result.modified} -${result.removed}`)
      } catch (itemError: any) {
        const plaidError = itemError?.response?.data
        const errorCode: string = plaidError?.error_code ?? ''
        if (errorCode === 'PRODUCT_NOT_READY') {
          console.log(`Item ${item.item_id}: PRODUCT_NOT_READY — will retry on next cron run`)
        } else {
          console.error(`Error on item ${item.item_id}:`, plaidError ?? itemError?.message ?? itemError)
        }
      }
    }

    const summary = {
      success: true,
      items_processed: itemsProcessed,
      transactions_added: totalAdded,
      transactions_modified: totalModified,
      transactions_removed: totalRemoved,
      synced_at: new Date().toISOString(),
    }
    console.log('Sync complete:', summary)
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } })

  } catch (error: any) {
    console.error('Scheduled sync failed:', error)
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 })
  }
})
