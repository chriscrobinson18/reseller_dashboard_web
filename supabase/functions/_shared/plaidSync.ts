// Shared Plaid per-item sync. Used by BOTH the on-demand sync
// (plaid_sync_transactions, user JWT) and the daily cron sync
// (plaid_sync_scheduled, service role, all users), so the two can't drift.
// Before 2026-11-09 the cron ran a stale fork (v27 logic) that skipped
// category rules, entity-ID / account-ID capture, settlement classification
// and the card-payment rule.
//
// Version history of this logic lives in plaid_sync_transactions/index.ts.
import { Configuration, PlaidApi, PlaidEnvironments } from "npm:plaid@47.0.0"

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
  // Credit-card payments (both the checking-side debit and the card-side
  // "PAYMENT - THANK YOU" credit). Moving money between your own accounts is
  // never Schedule C income or expense. Also covers loan payments generally —
  // principal is never deductible; business loan interest (Line 16) must be
  // split out by hand either way.
  'LOAN_PAYMENTS':      'transfer',
  'INCOME':             'payout',
  'BANK_FEES':          'other_expense',
  'FOOD_AND_DRINK':     'meals',
  'TRAVEL':             'travel',
  'RENT_AND_UTILITIES': 'utilities',
  'PERSONAL_CARE':      'personal',
  'MEDICAL':            'personal',
}

/**
 * Bank-account subtypes a marketplace payout or wallet cash-out can land in.
 * Plaid `type` must also be 'depository'. Credit cards ('credit'), loans,
 * investment accounts and wallet-style depository subtypes ('paypal',
 * 'prepaid', 'cd', 'hsa', …) are excluded on purpose.
 */
const SETTLEMENT_SUBTYPES = new Set(['checking', 'savings', 'money market', 'cash management'])

export type AccountKind = { type: string | null; subtype: string | null }

function isSettlementAccount(kind: AccountKind | undefined): boolean {
  return kind?.type === 'depository' && SETTLEMENT_SUBTYPES.has(kind.subtype ?? '')
}

/**
 * Classify a Plaid transaction as a marketplace settlement.
 * Only credits (plaidAmount < 0) from known marketplace sources that land in a
 * checking/savings-style deposit account qualify. Purchases/debits on
 * eBay/Amazon are expenses, not settlements.
 *
 * v37: credits on credit cards (eBay/Amazon/PayPal refunds of a purchase) are
 * NOT settlements. Before v37 any matching credit was tagged `settlement`,
 * which excluded the refund from Schedule C while the original purchase stayed
 * deducted (overstated expenses). They now fall through to category rules /
 * the PFC map like any other card row. An unknown account (missing from the
 * account map) fails closed: not a settlement.
 *
 * Plaid amount sign convention: positive = debit (money out), negative = credit (money in).
 */
export function classifySettlement(
  merchant: string | null,
  plaidAmount: number,
  account: AccountKind | undefined,
): { record_type: string; platform: string; schedule_c_category: string } | null {
  if (!merchant || plaidAmount >= 0) return null
  if (!isSettlementAccount(account)) return null

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

  // Wallet cash-outs: moving your own PayPal / Cash App balance to the
  // bank. Income is earned when the buyer pays into the wallet, not here, so
  // these are disbursements like a marketplace payout — same model as eBay:
  // income comes from the recorded sale, the bank deposit is a settlement.
  // Venmo is NOT here: it's personal-only by business policy, so its cash-outs
  // fall through to TRANSFER_IN → transfer. Zelle is excluded on purpose: it's a direct buyer payment with no wallet
  // in between, so it is NOT reclassified here (it still falls through to the
  // PFC map below — TRANSFER_IN → transfer). Pending a per-channel
  // deposits-vs-recorded-sales reconciliation before deciding its treatment.
  if (!/\bzelle\b/i.test(merchant)) {
    if (/paypal/i.test(merchant))
      return { record_type: 'settlement', platform: 'paypal', schedule_c_category: 'settlement' }
    if (/cash ?app/i.test(merchant))
      return { record_type: 'settlement', platform: 'cashapp', schedule_c_category: 'settlement' }
  }

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

function buildAccountKindMap(accounts: any[]): Record<string, AccountKind> {
  const map: Record<string, AccountKind> = {}
  for (const acct of accounts) {
    map[acct.account_id] = { type: acct.type ?? null, subtype: acct.subtype ?? null }
  }
  return map
}

function buildRow(
  tx: any,
  userId: string,
  accountMap: Record<string, string>,
  accountKinds: Record<string, AccountKind>,
) {
  const merchant = tx.merchant_name || tx.name
  const settlement = classifySettlement(merchant, tx.amount, accountKinds[tx.account_id])
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
    plaid_account_id: tx.account_id ?? null,
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

export type ItemSyncResult = {
  added: number
  modified: number
  removed: number
  settlements: number
  /** User-facing message when the item was skipped or failed. */
  warning?: string
}

/**
 * Sync one plaid_items row: pull /transactions/sync from the stored cursor,
 * insert / rename / update / delete transaction rows, apply settlement
 * classification, user category_rules and the PFC fallback, then save the
 * cursor. Plaid errors are written to plaid_items.status / error_message and
 * returned as `warning`; this function does not throw for per-item failures.
 *
 * `supabase` must be a service-role client: every query is scoped by
 * `userId` explicitly.
 */
export async function syncPlaidItem(
  supabase: any,
  item: any,
  userId: string,
  opts: { resetCursor?: boolean } = {},
): Promise<ItemSyncResult> {
  const resetCursor = opts.resetCursor === true
  const result: ItemSyncResult = { added: 0, modified: 0, removed: 0, settlements: 0 }
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
      return result
    }

    let cursor: string | null = resetCursor ? null : (item.cursor ?? null)
    let addedTx: any[] = []
    let modifiedTx: any[] = []
    let removedTx: any[] = []
    let accountMap: Record<string, string> = {}
    let accountKinds: Record<string, AccountKind> = {}
    let hasMore = true

    while (hasMore) {
      const resp = await plaidClient.transactionsSync({
        access_token: item.access_token,
        cursor: cursor ?? undefined,
        options: { include_personal_finance_category: true },
      })

      if (!Object.keys(accountMap).length) {
        accountMap = buildAccountMap(resp.data.accounts)
        accountKinds = buildAccountKindMap(resp.data.accounts)
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
          .eq('user_id', userId)
          .maybeSingle()

        if (existingPending) {
          // Defensive: confirm the posted row B isn't already in the DB
          // (e.g. a prior partial run inserted it). If it is, drop the
          // pending row A and let B stand.
          const { data: existingPosted } = await supabase
            .from('transactions')
            .select('id')
            .eq('plaid_transaction_id', tx.transaction_id)
            .eq('user_id', userId)
            .maybeSingle()

          const renamed = buildRow(tx, userId, accountMap, accountKinds)
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
      const rows = freshAdds.map((tx: any) => buildRow(tx, userId, accountMap, accountKinds))
      const settlements = rows.filter((r) => r.record_type === 'settlement').length
      result.settlements += settlements
      if (settlements > 0) console.log(`Item ${item.item_id}: ${settlements} settlements detected`)

      for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await supabase
          .from('transactions')
          .upsert(rows.slice(i, i + BATCH), { onConflict: 'plaid_transaction_id', ignoreDuplicates: true })
        if (error) console.error('Upsert added error:', error)
      }
      // v35: apply user category rules (higher priority than PFC fallback below).
      // One query fetches all matching rules for the batch; per-rule UPDATEs
      // stamp only null schedule_c_category rows.
      const entityIds = [...new Set(
        freshAdds
          .map((tx: any) => tx.merchant_entity_id as string | null | undefined)
          .filter((id): id is string => !!id)
      )]
      if (entityIds.length > 0) {
        const { data: ruleRows } = await supabase
          .from('category_rules')
          .select('merchant_entity_id, schedule_c_category')
          .eq('user_id', userId)
          .in('merchant_entity_id', entityIds)
        if (ruleRows && ruleRows.length > 0) {
          console.log(`Item ${item.item_id}: applying ${ruleRows.length} category rule(s)`)
          for (const rule of ruleRows) {
            await supabase
              .from('transactions')
              .update({ schedule_c_category: rule.schedule_c_category })
              .eq('user_id', userId)
              .eq('merchant_entity_id', rule.merchant_entity_id)
              .is('schedule_c_category', null)
          }
        }
      }

      // PFC fallback: categorize remaining null rows by Plaid's category signal.
      for (const [pfc, scheduleC] of Object.entries(PFC_TO_SCHEDULE_C)) {
        await supabase
          .from('transactions')
          .update({ schedule_c_category: scheduleC })
          .eq('user_id', userId)
          .eq('plaid_category', pfc)
          .eq('record_type', 'transaction')
          .is('schedule_c_category', null)
      }
      result.added += freshAdds.length
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
    const refreshRows = addedTx.map((tx: any) => buildRow(tx, userId, accountMap, accountKinds))
    for (const r of refreshRows) {
      const { error: metaErr } = await supabase
        .from('transactions')
        .update(plaidMetadataFields(r))
        .eq('plaid_transaction_id', r.plaid_transaction_id)
        .eq('user_id', userId)
      if (metaErr) console.error('Metadata refresh error:', metaErr)
    }

    // ── existing modified path (unchanged) ──
    if (modifiedTx.length > 0) {
      const rows = modifiedTx.map((tx: any) => buildRow(tx, userId, accountMap, accountKinds))
      for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await supabase
          .from('transactions')
          .upsert(rows.slice(i, i + BATCH), { onConflict: 'plaid_transaction_id', ignoreDuplicates: false })
        if (error) console.error('Upsert modified error:', error)
      }
      result.modified += modifiedTx.length
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
        .eq('user_id', userId)
        .not('receipt_url', 'is', null)
      if (withReceipts?.length) {
        await supabase.storage.from('receipts').remove(withReceipts.map((r: any) => r.receipt_url))
      }
      for (let i = 0; i < removedIds.length; i += BATCH) {
        await supabase.from('transactions').delete()
          .in('plaid_transaction_id', removedIds.slice(i, i + BATCH))
          .eq('user_id', userId)
      }
      result.removed += trulyRemoved.length
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
      result.warning = msg
      return result
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

    result.warning = (
      status === 'login_required'
        ? `${institution} needs to be reconnected — its login has expired, so new transactions aren't syncing.`
        : `${institution} failed to sync: ${detail}`
    )
  }
  return result
}
