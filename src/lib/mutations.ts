import { supabase } from './supabase'
import { splitLotCost } from './lotCost'
import type { Item, InventoryLot } from './types'
import { CATEGORIES } from './categories'
import { isColorKey, type ColorKey } from './categoryPalette'

// ─────────────────────────────────────────────────────────────────────────────
// All write/relational operations, mirroring iOS SupabaseClient.swift.
// RLS auto-scopes by user on SELECT; INSERTs must include user_id explicitly.
// ─────────────────────────────────────────────────────────────────────────────

async function getUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) throw new Error('Not authenticated')
  return data.user.id
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

// ─── Items ────────────────────────────────────────────────────────────────────

export async function createItem(name: string, category: string | null): Promise<Item> {
  const user_id = await getUserId()
  const { data, error } = await supabase
    .from('items')
    .insert({ user_id, name, category })
    .select()
    .single()
  if (error) throw error
  return data as Item
}

export async function updateItem(id: string, name: string, category: string | null) {
  const { error } = await supabase.from('items').update({ name, category }).eq('id', id)
  if (error) throw error
}

export async function deleteItem(id: string) {
  const { error } = await supabase
    .from('items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// ─── Inventory lots ───────────────────────────────────────────────────────────

/**
 * Creates the lot(s) for a purchase entered as a *total* cost.
 *
 * `splitLotCost` may return two tiers when the total doesn't divide evenly into
 * whole cents (3 for $10.00 → 2 × $3.33 + 1 × $3.34). Each tier needs its own
 * row because a lot carries a single unit_cost, so this can insert more than
 * one lot. They share item, purchase date, and transaction link.
 */
export async function createLotsForPurchase(params: {
  itemId: string
  quantity: number
  totalCost: number
  transactionId?: string | null
  purchaseDate?: string | null
}): Promise<InventoryLot[]> {
  const tiers = splitLotCost(params.totalCost, params.quantity)
  if (tiers.length === 0) throw new Error('Enter a valid quantity and total cost')

  const user_id = await getUserId()
  const { data, error } = await supabase
    .from('inventory_lots')
    .insert(tiers.map(t => ({
      user_id,
      item_id: params.itemId,
      transaction_id: params.transactionId ?? null,
      quantity_purchased: t.quantity,
      quantity_remaining: t.quantity,
      unit_cost: t.unitCost,
      purchase_date: params.purchaseDate ?? null,
    })))
    .select()
  if (error) throw error

  const lots = (data ?? []) as InventoryLot[]

  // Mirror the FK into the join table so reconciliation sees the funding.
  if (params.transactionId) {
    const { error: linkErr } = await supabase.from('inventory_lot_transactions').insert(
      lots.map(l => ({
        user_id,
        lot_id: l.id,
        transaction_id: params.transactionId!,
        allocated_amount: Number((l.quantity_purchased * l.unit_cost).toFixed(2)),
      })),
    )
    if (linkErr) throw linkErr
  }
  return lots
}

export async function updateLot(id: string, unitCost: number, quantityPurchased: number, quantityRemaining: number, purchaseDate: string | null) {
  const { error } = await supabase
    .from('inventory_lots')
    .update({ unit_cost: unitCost, quantity_purchased: quantityPurchased, quantity_remaining: quantityRemaining, purchase_date: purchaseDate })
    .eq('id', id)
  if (error) throw error
}

export async function deleteLot(id: string) {
  const { error } = await supabase
    .from('inventory_lots')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

// `inventory_lots.transaction_id` is a denormalized mirror of the oldest funding
// link, kept only for the sibling iOS app. It is maintained by the
// `inventory_lot_transactions_sync_primary` database trigger — deliberately NOT
// from here. The client-side read-then-write it replaced could race with a
// concurrent unlink and leave the column pointing at a deleted link.

/** Links an existing lot to a purchase (COGS) transaction. */
export async function linkLotToTransaction(lotId: string, transactionId: string, allocatedAmount: number) {
  const user_id = await getUserId()
  const { error } = await supabase
    .from('inventory_lot_transactions')
    .upsert(
      { user_id, lot_id: lotId, transaction_id: transactionId, allocated_amount: allocatedAmount },
      { onConflict: 'lot_id,transaction_id' },
    )
  if (error) throw error
}

/** Changes how much of an already-linked transaction funds this lot. */
export async function updateLotTransactionAmount(linkId: string, allocatedAmount: number) {
  const { error } = await supabase
    .from('inventory_lot_transactions')
    .update({ allocated_amount: allocatedAmount })
    .eq('id', linkId)
  if (error) throw error
}

/**
 * Links a lot to a purchase transaction, optionally recategorizing that
 * transaction as Cost of Goods and stamping the lot with the transaction's date.
 *
 * Exists because lots are often reconciled *backwards* — the user knows they
 * bought inventory and goes hunting for the bank transaction, which is
 * typically still uncategorized. Linking and categorizing separately would
 * leave a lot pointing at a non-COGS transaction, which breaks Part III.
 *
 * `purchaseDate` matters for the same reason: `AddLotModal` defaults a new lot
 * to *today*, so a lot entered now for a purchase made weeks ago carries a date
 * that misorders FIFO until it's corrected to the transaction's date.
 */
export async function linkLotToPurchase(params: {
  lotId: string
  transactionId: string
  markAsCogs: boolean
  /** Amount of this transaction that funded the lot. */
  allocatedAmount: number
  /** When set, overwrites the lot's purchase_date (use the transaction's date). */
  purchaseDate?: string | null
}) {
  await linkLotToTransaction(params.lotId, params.transactionId, params.allocatedAmount)

  if (params.purchaseDate) {
    const { error } = await supabase
      .from('inventory_lots')
      .update({ purchase_date: params.purchaseDate })
      .eq('id', params.lotId)
    if (error) throw error
  }

  if (params.markAsCogs) {
    await updateTransactionCategory(params.transactionId, 'cost_of_goods')
  }
}

/** Corrects just a lot's purchase date — used to align it with its linked transaction. */
export async function setLotPurchaseDate(lotId: string, purchaseDate: string) {
  const { error } = await supabase
    .from('inventory_lots')
    .update({ purchase_date: purchaseDate })
    .eq('id', lotId)
  if (error) throw error
}

/** Removes one funding link. Omit transactionId to detach the lot entirely. */
export async function unlinkLotFromTransaction(lotId: string, transactionId?: string) {
  let q = supabase.from('inventory_lot_transactions').delete().eq('lot_id', lotId)
  if (transactionId) q = q.eq('transaction_id', transactionId)
  const { error } = await q
  if (error) throw error
}

/**
 * Fetches non-deleted lots funded by a transaction, each carrying the amount
 * this particular transaction contributed (`allocated_amount`) — which for a
 * split-tender purchase is less than the lot's full cost.
 */
export async function fetchLotsForTransaction(
  transactionId: string,
): Promise<(InventoryLot & { items?: { name: string } | null; allocated_amount: number; link_id: string })[]> {
  const { data, error } = await supabase
    .from('inventory_lot_transactions')
    .select('id, allocated_amount, inventory_lots!inner(*, items(name))')
    .eq('transaction_id', transactionId)
    .is('inventory_lots.deleted_at', null)
    .order('created_at', { ascending: true })
  if (error) throw error

  return (data ?? []).map(row => {
    const r = row as unknown as {
      id: string
      allocated_amount: number
      inventory_lots: InventoryLot & { items?: { name: string } | null }
    }
    return { ...r.inventory_lots, allocated_amount: Number(r.allocated_amount), link_id: r.id }
  })
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export async function insertTransaction(params: {
  date: string
  amount: number // negative = expense, positive = income
  merchant: string | null
  type: string
  scheduleCCategory: string | null
  notes: string | null
}) {
  const user_id = await getUserId()
  const { error } = await supabase.from('transactions').insert({
    user_id,
    date: params.date,
    amount: params.amount,
    merchant: params.merchant,
    type: params.type,
    source: 'manual',
    schedule_c_category: params.scheduleCCategory,
    notes: params.notes,
  })
  if (error) throw error
}

export async function updateTransactionCategory(id: string, category: string | null) {
  const { error } = await supabase.from('transactions').update({ schedule_c_category: category }).eq('id', id)
  if (error) throw error
}

export async function updateTransactionNotes(id: string, notes: string) {
  const { error } = await supabase.from('transactions').update({ notes }).eq('id', id)
  if (error) throw error
}

/** Full edit of an editable transaction (date, amount, merchant, category, notes). */
export async function updateTransaction(params: {
  id: string
  date: string
  amount: number
  merchant: string | null
  type: string
  scheduleCCategory: string | null
  notes: string | null
}) {
  const { error } = await supabase
    .from('transactions')
    .update({
      date: params.date,
      amount: params.amount,
      merchant: params.merchant,
      type: params.type,
      schedule_c_category: params.scheduleCCategory,
      notes: params.notes,
    })
    .eq('id', params.id)
  if (error) throw error
}

/** Hard-deletes a transaction (mirrors iOS deleteTransaction). FK ON DELETE SET NULL unlinks lots. */
export async function deleteTransaction(id: string) {
  const { error } = await supabase.from('transactions').delete().eq('id', id)
  if (error) throw error
}

/** Net-zero pairs two transactions by giving them a shared pair UUID. */
export async function pairTransactions(id1: string, id2: string) {
  const pairId = crypto.randomUUID()
  const { error: e1 } = await supabase.from('transactions').update({ net_zero_pair_id: pairId }).eq('id', id1)
  if (e1) throw e1
  const { error: e2 } = await supabase.from('transactions').update({ net_zero_pair_id: pairId }).eq('id', id2)
  if (e2) throw e2
}

export async function unpairTransactions(id1: string, id2: string) {
  const { error } = await supabase.from('transactions').update({ net_zero_pair_id: null }).in('id', [id1, id2])
  if (error) throw error
}

// ─── Sales — the relational centerpiece ───────────────────────────────────────

export interface RecordSaleResult {
  saleId: string
  inventoryStatus: string
  unfulfilledQuantity: number
}

/**
 * Records a sale end-to-end (mirrors iOS recordSale):
 *  1. record_sale edge function — inserts the sale + FIFO-depletes inventory lots
 *     + creates inventory_movements audit rows.
 *  2. Writes fee/shipping/net_payout metadata onto the sale.
 *  3. Auto-creates payout / fee / shipping transaction rows linked via related_sale_id
 *     so the sale flows into Schedule C without double-counting.
 */
export async function recordSale(params: {
  itemId: string
  itemName?: string | null
  quantity: number
  salePrice: number
  platform: string
  soldAt: string // 'yyyy-MM-dd'
  externalOrderId?: string | null
  fees?: number | null
  shippingCost?: number | null
  /** How the buyer paid — see lib/paymentMethods.ts. */
  paymentMethod?: string | null
}): Promise<RecordSaleResult> {
  const soldAtIso = new Date(params.soldAt + 'T12:00:00').toISOString()

  const { data, error } = await supabase.functions.invoke('record_sale', {
    body: {
      item_id: params.itemId,
      quantity: params.quantity,
      sale_price: String(params.salePrice),
      platform: params.platform,
      sold_at: soldAtIso,
      source: 'manual',
      external_order_id: params.externalOrderId ?? null,
    },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)

  const saleId: string = data.sale_id
  if (!saleId) throw new Error('record_sale returned no sale_id')

  // Fields the record_sale edge function doesn't accept, written back onto the
  // row it just created. payment_method is always persisted; fee/shipping totals
  // (which drive the Profitability card) only when actually supplied, so a blank
  // fee field can't overwrite something the function already set.
  const patch: Record<string, unknown> = {
    payment_method: params.paymentMethod || null,
  }
  if (params.fees != null || params.shippingCost != null) {
    patch.external_order_id = params.externalOrderId ?? null
    patch.fees = params.fees ?? 0
    patch.shipping_cost = params.shippingCost ?? null
    patch.net_payout = params.salePrice - (params.fees ?? 0) - (params.shippingCost ?? 0)
  }
  await supabase.from('sales').update(patch).eq('id', saleId)

  // Create linked transaction rows (payout + fees + shipping).
  await createSaleTransactions({
    saleId,
    itemName: params.itemName ?? null,
    platform: params.platform,
    date: params.soldAt,
    salePrice: params.salePrice,
    fees: params.fees ?? null,
    shippingCost: params.shippingCost ?? null,
  })

  return {
    saleId,
    inventoryStatus: data.inventory_status,
    unfulfilledQuantity: data.unfulfilled_quantity ?? 0,
  }
}

/** Creates payout (+), fee (−), and shipping (−) transaction rows linked to a manual sale. */
export async function createSaleTransactions(params: {
  saleId: string
  itemName: string | null
  platform: string
  date: string
  salePrice: number
  fees: number | null
  shippingCost: number | null
}) {
  const user_id = await getUserId()
  const platformLabel = params.platform.charAt(0).toUpperCase() + params.platform.slice(1)

  const rows: Record<string, unknown>[] = [
    {
      user_id, date: params.date, amount: params.salePrice,
      merchant: params.itemName || platformLabel,
      type: 'other', source: 'manual',
      schedule_c_category: 'payout', related_sale_id: params.saleId,
    },
  ]
  if (params.fees && params.fees > 0) {
    rows.push({
      user_id, date: params.date, amount: -params.fees,
      merchant: `${platformLabel} Fee`, type: 'fee', source: 'manual',
      schedule_c_category: 'commissions_fees', related_sale_id: params.saleId,
    })
  }
  if (params.shippingCost && params.shippingCost > 0) {
    rows.push({
      user_id, date: params.date, amount: -params.shippingCost,
      merchant: 'Shipping', type: 'shipping', source: 'manual',
      schedule_c_category: 'shipping_postage', related_sale_id: params.saleId,
    })
  }
  const { error } = await supabase.from('transactions').insert(rows)
  if (error) throw error
}

/** Links an unlinked sale to an inventory item. */
export async function linkSaleToItem(saleId: string, itemId: string) {
  const { error } = await supabase.from('sales').update({ item_id: itemId }).eq('id', saleId)
  if (error) throw error
}

/**
 * Full edit of a sale (mirrors iOS updateSale). Updates the sale row, recomputes
 * net_payout, and for manual sales keeps the linked payout/fee/shipping transaction
 * rows in sync (amount + date) so Schedule C stays correct.
 */
export async function updateSale(params: {
  id: string
  source: string
  platform: string
  quantity: number
  salePrice: number
  soldAt: string // 'yyyy-MM-dd'
  externalOrderId: string | null
  fees: number | null
  shippingCost: number | null
  paymentMethod?: string | null
}) {
  const netPayout = params.salePrice - (params.fees ?? 0) - (params.shippingCost ?? 0)
  const { error } = await supabase
    .from('sales')
    .update({
      platform: params.platform,
      quantity: params.quantity,
      sale_price: params.salePrice,
      sold_at: new Date(params.soldAt + 'T12:00:00').toISOString(),
      external_order_id: params.externalOrderId,
      fees: params.fees ?? 0,
      shipping_cost: params.shippingCost ?? null,
      net_payout: netPayout,
      payment_method: params.paymentMethod || null,
    })
    .eq('id', params.id)
  if (error) throw error

  // For manual sales, keep linked transaction rows in sync.
  if (params.source !== 'manual') return
  const { data: linked, error: fetchErr } = await supabase
    .from('transactions')
    .select('id, schedule_c_category')
    .eq('related_sale_id', params.id)
    .eq('source', 'manual')
  if (fetchErr) throw fetchErr

  for (const tx of linked ?? []) {
    let newAmount: number | null
    switch (tx.schedule_c_category) {
      case 'payout': newAmount = params.salePrice; break
      case 'commissions_fees': newAmount = params.fees != null ? -params.fees : null; break
      case 'shipping_postage': newAmount = params.shippingCost != null ? -params.shippingCost : null; break
      default: continue
    }
    if (newAmount == null) continue
    await supabase
      .from('transactions')
      .update({ amount: newAmount, date: params.soldAt })
      .eq('id', tx.id)
  }
}

/**
 * Reverses a sale atomically via the reverse_sale edge function:
 * restores `quantity_remaining` on every depleted lot, removes the
 * `inventory_movements` audit rows, deletes linked manual transactions,
 * and soft-deletes the sale — all in one Postgres transaction.
 *
 * Pre-rewrite, this function only deleted the linked transactions and
 * soft-deleted the sale, leaving lots permanently understated. See
 * docs/superpowers/specs/2026-06-23-p0-tax-correctness-design.md § B
 * (P0 item 8) and supabase/functions/reverse_sale/.
 */
export async function deleteSale(id: string) {
  const { data, error } = await supabase.functions.invoke('reverse_sale', {
    body: { sale_id: id },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
}

/**
 * Processes a full or partial return: reverses the sale's FIFO inventory
 * movements (restoring quantity_remaining at each lot's original unit_cost),
 * updates the sale's refunded_quantity/refunded_amount/return_status, and
 * inserts a `returns_allowances`-categorized refund transaction row (plus a
 * `shipping_postage`-categorized one for `returnShippingCost`, if given —
 * the label cost of shipping the item back, paid by the seller). See
 * supabase/functions/record_return/.
 */
export async function recordReturn(params: {
  saleId: string
  quantity: number
  refundAmount: number
  returnShippingCost?: number | null
  reason?: string | null
}) {
  const { data, error } = await supabase.functions.invoke('record_return', {
    body: {
      sale_id: params.saleId,
      quantity: params.quantity,
      refund_amount: params.refundAmount,
      return_shipping_cost: params.returnShippingCost || undefined,
      reason: params.reason || undefined,
      source: 'manual',
    },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data as { success: true; sale_id: string; refunded_quantity: number; refunded_amount: number; units_restored: number }
}

/**
 * Undoes a single `returns` row (re-depletes inventory FIFO, decrements the
 * sale's refund totals, deletes the linked refund/return-shipping
 * transactions, deletes the `returns` row). Used to implement "edit a
 * return" as delete-then-re-record. See supabase/functions/reverse_return/.
 */
export async function reverseReturn(returnId: string) {
  const { data, error } = await supabase.functions.invoke('reverse_return', {
    body: { return_id: returnId },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
}

export interface ActiveReturn {
  id: string
  quantity: number
  refundAmount: number
  returnShippingCost: number
  reason: string
}

/**
 * Fetches the sale's most recent return (this app supports at most one
 * active return per sale) plus its linked return-shipping-cost transaction,
 * for pre-filling the edit-return form. Returns null if the sale has never
 * been returned.
 */
export async function fetchActiveReturn(saleId: string): Promise<ActiveReturn | null> {
  const { data: returns, error } = await supabase
    .from('returns')
    .select('id, quantity, refund_amount, reason')
    .eq('sale_id', saleId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  const ret = returns?.[0]
  if (!ret) return null

  const { data: shippingTxns, error: txErr } = await supabase
    .from('transactions')
    .select('amount')
    .eq('related_sale_id', saleId)
    .eq('type', 'refund')
    .eq('schedule_c_category', 'shipping_postage')
  if (txErr) throw txErr
  const returnShippingCost = (shippingTxns ?? []).reduce((sum, t) => sum - t.amount, 0)

  return {
    id: ret.id,
    quantity: ret.quantity,
    refundAmount: ret.refund_amount,
    returnShippingCost,
    reason: ret.reason ?? '',
  }
}

/**
 * Records a barter trade: creates a trades row, posts two non-cash transactions
 * (income + COGS, always equal and washing), optionally posts one cash boot
 * transaction, invokes record_sale per given line (FIFO depletes), and creates
 * new inventory_lots per received line with allocated FMV as unit_cost.
 *
 * Non-atomic in v1 — partial failure leaves partial state. On error the caller
 * should pass the returned tradeId (if any) to deleteTrade to roll back.
 *
 * See docs/superpowers/specs/2026-06-23-trades-design.md for the accounting model.
 */
export async function recordTrade(params: {
  tradedAt: string                              // 'yyyy-MM-dd'
  counterparty?: string | null
  notes?: string | null
  fmvSourceNotes?: string | null
  cashBoot: number                              // signed; + you received, − you paid, 0 pure swap
  given: Array<{
    itemId: string
    quantity: number
    fmv: number                                 // per-unit
    platform?: string | null
  }>
  received: Array<{
    itemId?: string | null                      // null => create new item
    newItemName?: string | null
    newItemCategory?: string | null
    quantity: number
    fmv: number                                 // per-unit (becomes lot.unit_cost)
  }>
}): Promise<{
  tradeId: string
  saleIds: string[]
  lotIds: string[]
  incomeTransactionId: string
  cogsTransactionId: string
  cashTransactionId: string | null
}> {
  const user_id = await getUserId()

  // ── 1. Validate ──────────────────────────────────────────────────────────
  if (params.given.length === 0) throw new Error('Trade must include at least one item given')
  if (params.received.length === 0) throw new Error('Trade must include at least one item received')

  const givenFmv = params.given.reduce((s, l) => s + l.fmv * l.quantity, 0)
  const receivedFmv = params.received.reduce((s, l) => s + l.fmv * l.quantity, 0)
  const cashPaid = Math.max(-params.cashBoot, 0)
  const cashReceived = Math.max(params.cashBoot, 0)
  if (Math.abs((givenFmv + cashPaid) - (receivedFmv + cashReceived)) > 0.01) {
    throw new Error(
      `Trade is unbalanced: given $${givenFmv.toFixed(2)} + cash paid $${cashPaid.toFixed(2)} ` +
      `≠ received $${receivedFmv.toFixed(2)} + cash received $${cashReceived.toFixed(2)}`
    )
  }
  for (const r of params.received) {
    if (!r.itemId && !r.newItemName) throw new Error('Each received line needs an itemId or a newItemName')
  }

  // Non-cash leg amount = given_fmv − max(cash_received, 0). See spec § Canonical rule.
  const nonCashLegAmount = givenFmv - cashReceived
  if (nonCashLegAmount <= 0) {
    throw new Error(
      'Trade has no non-cash exchange (all consideration is cash). ' +
      'Use Record Sale for pure cash transactions instead of Record Trade.'
    )
  }

  // ── 2. Insert trades row (FKs back-filled in step 6) ─────────────────────
  const { data: tradeRow, error: tradeErr } = await supabase
    .from('trades')
    .insert({
      user_id,
      traded_at: params.tradedAt,
      counterparty: params.counterparty ?? null,
      given_fmv: givenFmv,
      received_fmv: receivedFmv,
      cash_boot: params.cashBoot,
      fmv_source_notes: params.fmvSourceNotes ?? null,
      notes: params.notes ?? null,
    })
    .select()
    .single()
  if (tradeErr || !tradeRow) throw tradeErr ?? new Error('Failed to create trade row')
  const tradeId: string = tradeRow.id

  const merchant = params.counterparty?.trim() || 'Trade'

  // ── 3 & 4. Non-cash income + COGS transactions ──────────────────────────
  const { data: txRows, error: txErr } = await supabase
    .from('transactions')
    .insert([
      {
        user_id,
        date: params.tradedAt,
        amount: nonCashLegAmount,
        merchant,
        type: 'other',
        source: 'manual',
        record_type: 'transaction',
        schedule_c_category: 'payout',
        is_non_cash: true,
        trade_id: tradeId,
        notes: 'Trade — non-cash income leg',
      },
      {
        user_id,
        date: params.tradedAt,
        amount: -nonCashLegAmount,
        merchant,
        type: 'other',
        source: 'manual',
        record_type: 'transaction',
        schedule_c_category: 'cost_of_goods',
        is_non_cash: true,
        trade_id: tradeId,
        notes: 'Trade — non-cash COGS leg',
      },
    ])
    .select()
  if (txErr || !txRows || txRows.length !== 2) throw txErr ?? new Error('Failed to create non-cash trade transactions')
  const incomeTx = txRows.find(r => r.amount > 0)!
  const cogsTx = txRows.find(r => r.amount < 0)!

  // ── 5. Cash boot transaction (if any) ───────────────────────────────────
  let cashTransactionId: string | null = null
  if (params.cashBoot !== 0) {
    const { data: cashRow, error: cashErr } = await supabase
      .from('transactions')
      .insert({
        user_id,
        date: params.tradedAt,
        amount: params.cashBoot,
        merchant,
        type: params.cashBoot > 0 ? 'other' : 'expense',
        source: 'manual',
        record_type: 'transaction',
        schedule_c_category: params.cashBoot > 0 ? 'payout' : 'cost_of_goods',
        is_non_cash: false,
        trade_id: tradeId,
        notes: 'Trade — cash boot',
      })
      .select()
      .single()
    if (cashErr || !cashRow) throw cashErr ?? new Error('Failed to create cash boot transaction')
    cashTransactionId = cashRow.id
  }

  // ── 6. Back-fill transaction FKs on the trades row ──────────────────────
  const { error: updTradeErr } = await supabase
    .from('trades')
    .update({
      income_transaction_id: incomeTx.id,
      cogs_transaction_id: cogsTx.id,
      cash_transaction_id: cashTransactionId,
    })
    .eq('id', tradeId)
  if (updTradeErr) throw updTradeErr

  // ── 7. Given-side sales (via record_sale; skip createSaleTransactions) ──
  const saleIds: string[] = []
  for (const g of params.given) {
    const soldAtIso = new Date(params.tradedAt + 'T12:00:00').toISOString()
    const { data: saleData, error: saleErr } = await supabase.functions.invoke('record_sale', {
      body: {
        item_id: g.itemId,
        quantity: g.quantity,
        sale_price: String(g.fmv * g.quantity),       // line total to match recordSale convention
        platform: g.platform ?? 'trade',
        sold_at: soldAtIso,
        source: 'trade',
        external_order_id: null,
      },
    })
    if (saleErr) throw saleErr
    if (saleData?.error) throw new Error(saleData.error)
    const saleId: string = saleData.sale_id
    if (!saleId) throw new Error('record_sale returned no sale_id')
    // record_sale returns inventory_status: 'ok' on success, 'oversold' on
    // partial. We can't trade items we don't fully own, so we abort on any
    // partial — the user must cancel and call deleteTrade to roll back.
    if ((saleData.unfulfilled_quantity ?? 0) > 0) {
      throw new Error(
        `Insufficient stock for given item (${g.itemId}): ` +
        `${saleData.unfulfilled_quantity} unit(s) could not be fulfilled. ` +
        `Cancel and call deleteTrade('${tradeId}') to roll back.`
      )
    }

    const { error: stampErr } = await supabase
      .from('sales')
      .update({
        trade_id: tradeId,
        fees: 0,
        shipping_cost: null,
        net_payout: g.fmv * g.quantity,
      })
      .eq('id', saleId)
    if (stampErr) throw stampErr

    saleIds.push(saleId)
  }

  // ── 8. Received-side lots ───────────────────────────────────────────────
  const lotIds: string[] = []
  for (const r of params.received) {
    let itemId = r.itemId
    if (!itemId) {
      const { data: newItem, error: newItemErr } = await supabase
        .from('items')
        .insert({ user_id, name: r.newItemName!, category: r.newItemCategory ?? null })
        .select()
        .single()
      if (newItemErr || !newItem) throw newItemErr ?? new Error('Failed to create item')
      itemId = newItem.id
    }
    const { data: lotRow, error: lotErr } = await supabase
      .from('inventory_lots')
      .insert({
        user_id,
        item_id: itemId,
        transaction_id: cogsTx.id,
        trade_id: tradeId,
        quantity_purchased: r.quantity,
        quantity_remaining: r.quantity,
        unit_cost: r.fmv,
      })
      .select()
      .single()
    if (lotErr || !lotRow) throw lotErr ?? new Error('Failed to create received lot')

    const { error: linkErr } = await supabase.from('inventory_lot_transactions').insert({
      user_id,
      lot_id: lotRow.id,
      transaction_id: cogsTx.id,
      allocated_amount: Number((r.fmv * r.quantity).toFixed(2)),
    })
    if (linkErr) throw linkErr

    lotIds.push(lotRow.id)
  }

  return {
    tradeId,
    saleIds,
    lotIds,
    incomeTransactionId: incomeTx.id,
    cogsTransactionId: cogsTx.id,
    cashTransactionId,
  }
}

/**
 * Deletes a trade and reverses all its linked records.
 *
 * Aborts if any received-side lot has been depleted (quantity_remaining < quantity_purchased),
 * because deleting the trade would orphan the downstream sales' COGS. User must delete those
 * sales first.
 *
 * Otherwise:
 *   1. reverse_sale on each given-side sale (atomic FIFO restore + audit cleanup + soft-delete)
 *   2. Hard-delete the 2 (or 3) trade transactions
 *   3. Soft-delete each received-side lot
 *   4. Soft-delete the trades row
 */
export async function deleteTrade(tradeId: string): Promise<void> {
  // Load the trade + linked received lots to check depletion.
  const { data: trade, error: tradeErr } = await supabase
    .from('trades')
    .select('id, income_transaction_id, cogs_transaction_id, cash_transaction_id')
    .eq('id', tradeId)
    .is('deleted_at', null)
    .single()
  if (tradeErr || !trade) throw tradeErr ?? new Error('Trade not found')

  const { data: receivedLots, error: lotsErr } = await supabase
    .from('inventory_lots')
    .select('id, quantity_purchased, quantity_remaining')
    .eq('trade_id', tradeId)
    .is('deleted_at', null)
  if (lotsErr) throw lotsErr

  const depleted = (receivedLots ?? []).filter(l => l.quantity_remaining < l.quantity_purchased)
  if (depleted.length > 0) {
    throw new Error(
      `Cannot delete trade — ${depleted.length} received lot(s) have been partially or fully sold. ` +
      `Delete the downstream sale(s) first, then delete this trade.`
    )
  }

  const { data: givenSales, error: salesErr } = await supabase
    .from('sales')
    .select('id')
    .eq('trade_id', tradeId)
    .is('deleted_at', null)
  if (salesErr) throw salesErr

  // 1. Reverse each given-side sale atomically.
  for (const s of givenSales ?? []) {
    const { data, error } = await supabase.functions.invoke('reverse_sale', { body: { sale_id: s.id } })
    if (error) throw error
    if (data?.error) throw new Error(data.error)
  }

  // 2. Hard-delete trade transactions.
  // Union FK-derived txn IDs with any orphan txns linked by trade_id (defense against
  // recordTrade partial-failure leaving trade row with NULL FKs but real transactions).
  const fkTxIds = [trade.income_transaction_id, trade.cogs_transaction_id, trade.cash_transaction_id]
    .filter((x): x is string => !!x)
  const { data: orphanTxRows, error: orphanErr } = await supabase
    .from('transactions')
    .select('id')
    .eq('trade_id', tradeId)
  if (orphanErr) throw orphanErr
  const allTxIds = Array.from(new Set([...fkTxIds, ...(orphanTxRows ?? []).map(t => t.id)]))
  if (allTxIds.length > 0) {
    const { error } = await supabase.from('transactions').delete().in('id', allTxIds)
    if (error) throw error
  }

  // 3. Soft-delete received lots.
  if ((receivedLots ?? []).length > 0) {
    const { error } = await supabase
      .from('inventory_lots')
      .update({ deleted_at: new Date().toISOString() })
      .eq('trade_id', tradeId)
      .is('deleted_at', null)
    if (error) throw error
  }

  // 4. Soft-delete the trade.
  const { error: tradeDelErr } = await supabase
    .from('trades')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', tradeId)
  if (tradeDelErr) throw tradeDelErr
}

export { todayStr }

// ─── Custom categories ────────────────────────────────────────────────────────

interface CustomCategoryInput {
  name: string
  colorKey: ColorKey
  parentValue: string | null  // exactly one of parentValue / scheduleLine must be non-null
  scheduleLine: string | null
}

const ALLOWED_SCHEDULE_LINES: string[] = (() => {
  const lines = new Set<string>(['Part I', 'Part III'])
  for (const c of CATEGORIES) {
    if (c.scheduleLine?.startsWith('Line ') && c.scheduleLine !== 'Line 24b') {
      lines.add(c.scheduleLine)
    }
  }
  return Array.from(lines)
})()

function validateCustomCategoryInput(input: Partial<CustomCategoryInput>): void {
  if (input.name !== undefined) {
    const trimmed = input.name.trim()
    if (trimmed.length === 0) throw new Error('Name is required')
    if (trimmed.length > 40) throw new Error('Name must be 40 characters or fewer')
  }
  if (input.colorKey !== undefined && !isColorKey(input.colorKey)) {
    throw new Error('Invalid color')
  }
  if (input.parentValue !== undefined && input.scheduleLine !== undefined) {
    const hasParent = input.parentValue !== null
    const hasLine = input.scheduleLine !== null
    if (hasParent === hasLine) {
      throw new Error('Pick either a parent category or a Schedule C line, not both')
    }
  }
  if (input.parentValue) {
    if (!CATEGORIES.find(c => c.value === input.parentValue)) {
      throw new Error(`Unknown parent category: ${input.parentValue}`)
    }
  }
  if (input.scheduleLine) {
    if (!ALLOWED_SCHEDULE_LINES.includes(input.scheduleLine)) {
      throw new Error(`Invalid Schedule C line: ${input.scheduleLine}`)
    }
  }
}

export async function createCustomCategory(input: CustomCategoryInput): Promise<string> {
  validateCustomCategoryInput(input)
  const user_id = await getUserId()

  // Soft uniqueness — block creating a second active row with the same name.
  const { data: existing } = await supabase
    .from('custom_categories')
    .select('id')
    .eq('user_id', user_id)
    .is('deleted_at', null)
    .ilike('name', input.name.trim())
    .limit(1)
  if (existing && existing.length > 0) {
    throw new Error(`A category named "${input.name.trim()}" already exists`)
  }

  const { data, error } = await supabase
    .from('custom_categories')
    .insert({
      user_id,
      name: input.name.trim(),
      color_key: input.colorKey,
      parent_value: input.parentValue,
      schedule_line: input.scheduleLine,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

export async function updateCustomCategory(
  id: string,
  patch: Partial<CustomCategoryInput>,
): Promise<void> {
  validateCustomCategoryInput(patch)

  // The DB CHECK enforces parent_value XOR schedule_line. The patch-level XOR
  // check inside validateCustomCategoryInput only fires when BOTH fields are
  // present; a one-sided patch (only parentValue, only scheduleLine) would
  // sneak past and only fail at the DB with an opaque constraint error.
  // Require callers to send both together (or neither — name/colorKey-only is fine).
  const touchesParent = patch.parentValue !== undefined
  const touchesLine = patch.scheduleLine !== undefined
  if (touchesParent !== touchesLine) {
    throw new Error(
      'updateCustomCategory: parentValue and scheduleLine must be patched together (or neither)',
    )
  }

  // If patching name, recheck soft-uniqueness against the user's other active rows.
  if (patch.name !== undefined) {
    const user_id = await getUserId()
    const { data: existing } = await supabase
      .from('custom_categories')
      .select('id')
      .eq('user_id', user_id)
      .is('deleted_at', null)
      .neq('id', id)
      .ilike('name', patch.name.trim())
      .limit(1)
    if (existing && existing.length > 0) {
      throw new Error(`A category named "${patch.name.trim()}" already exists`)
    }
  }

  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) row.name = patch.name.trim()
  if (patch.colorKey !== undefined) row.color_key = patch.colorKey
  if (patch.parentValue !== undefined) row.parent_value = patch.parentValue
  if (patch.scheduleLine !== undefined) row.schedule_line = patch.scheduleLine

  const { error } = await supabase.from('custom_categories').update(row).eq('id', id)
  if (error) throw error
}

export async function deleteCustomCategory(id: string): Promise<void> {
  const { error } = await supabase
    .from('custom_categories')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

/** Counts transactions referencing the custom category — used by the delete confirmation dialog. */
export async function countTransactionsUsingCustomCategory(customCategoryId: string): Promise<number> {
  const value = `cust_${customCategoryId.replace(/-/g, '')}`
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('schedule_c_category', value)
  if (error) throw error
  return count ?? 0
}

// ────────────────────────────────────────────────────────────
// Plaid
// ────────────────────────────────────────────────────────────

export interface PlaidCreateLinkTokenResult {
  link_token: string
  expiration?: string
}

/**
 * Calls plaid_create_link_token. Pass an item_id to request an update-mode token
 * (used when a connection has status='login_required' and needs re-auth).
 */
export async function plaidCreateLinkToken(itemId?: string): Promise<PlaidCreateLinkTokenResult> {
  const body = itemId ? { item_id: itemId } : {}
  const { data, error } = await supabase.functions.invoke('plaid_create_link_token', { body })
  if (error) throw error
  return data as PlaidCreateLinkTokenResult
}

/**
 * Exchanges a Plaid Link public_token for an access_token and persists a plaid_items row
 * (or refreshes the existing one for update mode). Backend reads institution from metadata.
 */
export async function plaidExchangeToken(params: {
  public_token: string
  metadata: unknown
}): Promise<void> {
  const { error } = await supabase.functions.invoke('plaid_exchange_token', {
    body: params,
  })
  if (error) throw error
}

export interface PlaidSyncResult {
  success?: boolean
  transactions_added?: number
  transactions_modified?: number
  transactions_removed?: number
  settlements_detected?: number
  /**
   * Per-item problems. v33+ reports connections that need reconnecting or
   * otherwise failed; earlier versions only ever reported PRODUCT_NOT_READY and
   * swallowed everything else, so `success: true` could hide a dead item.
   */
  warnings?: string[]
  /** Legacy field name — never actually emitted by v32+; kept for old responses. */
  inserted?: number
}

/**
 * Triggers an incremental Plaid sync. When `reset_cursor=true`, the backend must clear the
 * stored cursor first and re-pull full history. If the backend ignores the flag, Force Full
 * Resync silently degrades to a normal Sync Now — documented in the spec.
 */
export async function plaidSyncTransactions(params: {
  item_id: string
  reset_cursor?: boolean
}): Promise<PlaidSyncResult> {
  const { data, error } = await supabase.functions.invoke('plaid_sync_transactions', {
    body: params,
  })
  if (error) throw error
  return (data ?? {}) as PlaidSyncResult
}

/** Disconnects an institution. Backend removes plaid_items + cascades plaid_accounts. */
export async function plaidRemoveItem(itemId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('plaid_remove_item', {
    body: { item_id: itemId },
  })
  if (error) throw error
}

/** Direct table update — RLS scopes by user_id. */
export async function updatePlaidAccount(
  id: string,
  patch: { display_name?: string | null; sync_enabled?: boolean }
): Promise<void> {
  const { error } = await supabase.from('plaid_accounts').update(patch).eq('id', id)
  if (error) throw error
}
