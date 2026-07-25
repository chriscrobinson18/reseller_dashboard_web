// plaid_sync_transactions v33
// v33: surface item failures instead of swallowing them. Any Plaid error other
// than PRODUCT_NOT_READY now writes plaid_items.status/error_message and returns
// a warning, and a clean sync resets status to 'active'. Previously these were
// console.error-only while the response still reported success, so an expired
// connection kept rendering a green "Connected" badge indefinitely.
// plaid_sync_transactions v32
// Adds rich Plaid metadata capture: 14 new columns on transactions (logo, location,
// payment_channel, authorized_date, pending, detailed PFC + confidence, currency,
// plaid_metadata jsonb). A side-channel metadata UPDATE pass refreshes those fields
// on existing rows (so Force Full Resync backfills history without overwriting user
// edits: schedule_c_category, notes, related_sale_id, receipt_url, parent_settlement_id).
// Pending→posted handoff renames pending rows in place using pending_transaction_id,
// preserving any user edits on the pending row instead of delete-then-insert.
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

/**
 * Plaid error codes that mean the user must re-authenticate through Link in
 * update mode. Retrying the sync — including Force Full Resync, which only
 * resets the cursor — cannot clear any of these.
 */
const NEEDS_RECONNECT = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'USER_PERMISSION_REVOKED',
  'USER_INPUT_TIMEOUT',
  'ITEM_LOCKED',
])

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
  const loc = tx.location ?? {}
  const pfc = tx.personal_finance_category ?? {}
  return {
    user_id: userId,
    plaid_transaction_id: tx.transaction_id,
    date: tx.date,
    amount: -tx.amount,
    merchant,
    type: getTransactionType(tx),
    source: 'plaid',
    account_display: accountMap[tx.account_id] ?? null,
    plaid_category: pfc.primary ?? null,
    record_type: settlement?.record_type ?? 'transaction',
    platform: settlement?.platform ?? null,
    ...(settlement ? { schedule_c_category: settlement.schedule_c_category } : {}),
    // ── new fields (v32) ──
    merchant_logo_url: tx.logo_url ?? null,
    merchant_website: tx.website ?? null,
    merchant_entity_id: tx.merchant_entity_id ?? null,
    location_city: loc.city ?? null,
    location_region: loc.region ?? null,
    location_store_number: loc.store_number ?? null,
    payment_channel: tx.payment_channel ?? null,
    authorized_date: tx.authorized_date ?? null,
    iso_currency_code: tx.iso_currency_code ?? null,
    pending: tx.pending === true,
    pending_plaid_transaction_id: tx.pending_transaction_id ?? null,
    plaid_category_detailed: pfc.detailed ?? null,
    plaid_category_confidence: pfc.confidence_level ?? null,
    plaid_metadata: tx,
  }
}

/**
 * The 14 metadata columns added in v32. Used by the side-channel UPDATE pass
 * to refresh metadata on existing rows without touching user edits or the
 * canonical economic fields (amount/date/merchant/type).
 */
function plaidMetadataFields(r: ReturnType<typeof buildRow>) {
  return {
    merchant_logo_url: r.merchant_logo_url,
    merchant_website: r.merchant_website,
    merchant_entity_id: r.merchant_entity_id,
    location_city: r.location_city,
    location_region: r.location_region,
    location_store_number: r.location_store_number,
    payment_channel: r.payment_channel,
    authorized_date: r.authorized_date,
    iso_currency_code: r.iso_currency_code,
    pending: r.pending,
    pending_plaid_transaction_id: r.pending_plaid_transaction_id,
    plaid_category_detailed: r.plaid_category_detailed,
    plaid_category_confidence: r.plaid_category_confidence,
    plaid_metadata: r.plaid_metadata,
  }
}

/**
 * Everything buildRow() produces EXCEPT user-editable fields. Used by the
 * pending→posted handoff to rename a pending row into a posted row in place
 * (changes plaid_transaction_id, pending, amount/date/merchant if they
 * changed, and all metadata) while preserving schedule_c_category, notes,
 * related_sale_id, receipt_url, parent_settlement_id.
 */
function plaidRowFields(r: ReturnType<typeof buildRow>) {
  const rest: Record<string, unknown> = { ...r }
  delete rest.schedule_c_category
  // user_id is set on insert; never overwrite during a rename.
  delete rest.user_id
  return rest
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

        // ── v32: pending → posted handoff ──
        // Plaid removes the pending row and adds a new posted row with
        // pending_transaction_id pointing back. Rename the existing row
        // in place instead of delete+insert so user edits survive.
        const consumedPendingIds = new Set<string>()
        const freshAdds: any[] = []
        for (const tx of addedTx) {
          if (tx.pending_transaction_id) {
            const { data: existingPending } = await supabase
              .from('transactions')
              .select('id')
              .eq('plaid_transaction_id', tx.pending_transaction_id)
              .eq('user_id', user.id)
              .maybeSingle()

            if (existingPending) {
              // Defensive: confirm the posted row B isn't already in the DB
              // (e.g. a prior partial run inserted it). If it is, drop the
              // pending row A and let B stand.
              const { data: existingPosted } = await supabase
                .from('transactions')
                .select('id')
                .eq('plaid_transaction_id', tx.transaction_id)
                .eq('user_id', user.id)
                .maybeSingle()

              const renamed = buildRow(tx, user.id, accountMap)
              // Only mark the pending id as "consumed" if the rename/delete
              // actually succeeded. On failure we fall through to freshAdds so
              // the new posted row gets inserted normally and the stale
              // pending row gets removed by the regular `removed` cleanup —
              // worse than the handoff path, but better than orphaning the
              // pending row AND blocking its cleanup.
              let consumed = false
              if (existingPosted) {
                const { error: delErr } = await supabase
                  .from('transactions')
                  .delete()
                  .eq('id', existingPending.id)
                if (delErr) console.error('Pending cleanup delete error:', delErr)
                else consumed = true
              } else {
                const { error: renameErr } = await supabase
                  .from('transactions')
                  .update(plaidRowFields(renamed))
                  .eq('id', existingPending.id)
                if (renameErr) console.error('Pending→posted rename error:', renameErr)
                else consumed = true
              }
              if (consumed) {
                consumedPendingIds.add(tx.pending_transaction_id)
                continue
              }
              // fall through: handoff failed, treat as a fresh add
            }
          }
          freshAdds.push(tx)
        }

        // ── existing added insertion (unchanged behavior, freshAdds only) ──
        if (freshAdds.length > 0) {
          const rows = freshAdds.map((tx: any) => buildRow(tx, user.id, accountMap))
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
          totalAdded += freshAdds.length
        }

        // ── v32: metadata refresh pass ──
        // Load-bearing for the Force Full Resync case: when cursor is reset,
        // Plaid re-delivers historical transactions in `added`. The upsert
        // above uses ignoreDuplicates:true, so existing rows are skipped — this
        // pass is what writes the 14 new metadata columns onto those rows.
        //
        // For freshly-inserted rows (freshAdds) and renamed handoff rows, this
        // pass is a redundant no-op write of the same values just written.
        // Kept simple (one UPDATE per addedTx row) rather than tracking which
        // rows were inserted vs. skipped — the alternative is an extra
        // existence check per row, same N+1 cost, more code.
        //
        // User-editable fields are excluded from the SET clause via
        // plaidMetadataFields.
        const refreshRows = addedTx.map((tx: any) => buildRow(tx, user.id, accountMap))
        for (const r of refreshRows) {
          const { error: metaErr } = await supabase
            .from('transactions')
            .update(plaidMetadataFields(r))
            .eq('plaid_transaction_id', r.plaid_transaction_id)
            .eq('user_id', user.id)
          if (metaErr) console.error('Metadata refresh error:', metaErr)
        }

        // ── existing modified path (unchanged) ──
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

        // ── v32: removed-skip filter ──
        // Pending rows that we just renamed into posted rows above will
        // appear in Plaid's `removed`. Skip them — we already kept the row.
        const trulyRemoved = removedTx.filter(
          (tx: any) => !consumedPendingIds.has(tx.transaction_id),
        )
        if (trulyRemoved.length > 0) {
          const removedIds = trulyRemoved.map((tx: any) => tx.transaction_id)
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
          totalRemoved += trulyRemoved.length
        }

        // Clear any prior failure state — otherwise a reconnected item keeps
        // showing "Reconnect needed" forever.
        await supabase
          .from('plaid_items')
          .update({
            cursor,
            last_synced_at: new Date().toISOString(),
            status: 'active',
            error_message: null,
          })
          .eq('item_id', item.item_id)

        console.log(`Item ${item.item_id} done: +${addedTx.length} ~${modifiedTx.length} -${removedTx.length}`)

      } catch (itemErr: any) {
        const plaidError = itemErr?.response?.data
        const errorCode: string = plaidError?.error_code ?? ''
        const institution = item.institution_name ?? 'Bank'

        if (errorCode === 'PRODUCT_NOT_READY') {
          const msg = 'Transaction history is being prepared by your bank. Please sync again in a few minutes.'
          console.log(`Item ${item.item_id}: PRODUCT_NOT_READY`)
          warnings.push(msg)
          continue
        }

        // Everything below used to be console.error only: the failure never
        // reached plaid_items.status and the response still said success, so a
        // dead connection kept rendering a green "Connected" badge. One item's
        // consent expired and went unnoticed for ~4 months.
        console.error(`Error syncing item ${item.item_id}:`, plaidError ?? itemErr?.message ?? itemErr)

        const status = NEEDS_RECONNECT.has(errorCode) ? 'login_required' : 'error'
        const detail: string = plaidError?.error_message ?? itemErr?.message ?? errorCode ?? 'Unknown error'

        await supabase
          .from('plaid_items')
          .update({ status, error_message: errorCode ? `${errorCode}: ${detail}` : detail })
          .eq('item_id', item.item_id)

        warnings.push(
          status === 'login_required'
            ? `${institution} needs to be reconnected — its login has expired, so new transactions aren't syncing.`
            : `${institution} failed to sync: ${detail}`,
        )
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
