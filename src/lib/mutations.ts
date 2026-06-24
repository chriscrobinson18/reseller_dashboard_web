import { supabase } from './supabase'
import type { Item, InventoryLot } from './types'

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

/** Creates an inventory lot. Pass transactionId to link it to a COGS purchase transaction. */
export async function createLot(params: {
  itemId: string
  quantity: number
  unitCost: number
  transactionId?: string | null
  purchaseDate?: string | null
}): Promise<InventoryLot> {
  const user_id = await getUserId()
  const { data, error } = await supabase
    .from('inventory_lots')
    .insert({
      user_id,
      item_id: params.itemId,
      transaction_id: params.transactionId ?? null,
      quantity_purchased: params.quantity,
      quantity_remaining: params.quantity,
      unit_cost: params.unitCost,
    })
    .select()
    .single()
  if (error) throw error
  return data as InventoryLot
}

export async function updateLot(id: string, unitCost: number, quantityPurchased: number, quantityRemaining: number) {
  const { error } = await supabase
    .from('inventory_lots')
    .update({ unit_cost: unitCost, quantity_purchased: quantityPurchased, quantity_remaining: quantityRemaining })
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

/** Links an existing lot to a purchase (COGS) transaction. */
export async function linkLotToTransaction(lotId: string, transactionId: string) {
  const { error } = await supabase
    .from('inventory_lots')
    .update({ transaction_id: transactionId })
    .eq('id', lotId)
  if (error) throw error
}

export async function unlinkLotFromTransaction(lotId: string) {
  const { error } = await supabase
    .from('inventory_lots')
    .update({ transaction_id: null })
    .eq('id', lotId)
  if (error) throw error
}

/** Fetches non-deleted lots linked to a transaction (for the COGS detail panel). */
export async function fetchLotsForTransaction(transactionId: string): Promise<(InventoryLot & { items?: { name: string } | null })[]> {
  const { data, error } = await supabase
    .from('inventory_lots')
    .select('*, items(name)')
    .eq('transaction_id', transactionId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
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

  // Persist fee/shipping totals (drives the Profitability card).
  if (params.fees != null || params.shippingCost != null) {
    const netPayout = params.salePrice - (params.fees ?? 0) - (params.shippingCost ?? 0)
    await supabase
      .from('sales')
      .update({
        external_order_id: params.externalOrderId ?? null,
        fees: params.fees ?? 0,
        shipping_cost: params.shippingCost ?? null,
        net_payout: netPayout,
      })
      .eq('id', saleId)
  }

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

export { todayStr }
