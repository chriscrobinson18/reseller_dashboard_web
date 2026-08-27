import { supabase } from './supabase'
import { splitLotCost, basisFromAdjustments, type LotBasis } from './lotCost'
import { ADJUSTMENT_LABELS } from './lotAdjustments'
import type { Item, InventoryLot, LotAdjustmentType, CSVImportResult, CSVSaleSyncResult } from './types'
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
  const deleted_at = new Date().toISOString()
  const { error } = await supabase
    .from('inventory_lots')
    .update({ deleted_at })
    .eq('id', id)
  if (error) throw error

  // Cascade to the lot's capitalized costs so they can't resurface as orphans.
  // Their `transactions` deliberately survive: deleting a lot means "I'm no
  // longer tracking this card", but the grading fee was still really paid and
  // is still deductible. Same reasoning as deleteSale keeping bank rows.
  const { error: adjErr } = await supabase
    .from('lot_cost_adjustments')
    .update({ deleted_at })
    .eq('lot_id', id)
    .is('deleted_at', null)
  if (adjErr) throw adjErr
}

// ─── Box openings ─────────────────────────────────────────────────────────────

/**
 * Opens a box the user already holds as inventory: depletes `quantity` units
 * of `sourceLotId` and turns that cost into N single-card lots, allocated by
 * `allocationMethod` (relative FMV, equal split, or the user's own $ entries).
 * See docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md.
 *
 * No new transaction is created. The box was bought and entered into
 * inventory like any other lot — its cost is already deducted on Schedule C
 * (linked + categorized cost_of_goods at purchase time, same as every other
 * lot). Opening it just reclassifies that already-deducted cost across the
 * resulting cards; posting a second cost_of_goods row here would double-
 * deduct it. The resulting card lots mirror the source lot's
 * `transaction_id` (may be null) purely for display continuity.
 *
 * Not wrapped in a server-side transaction (v1, per spec) — if a card insert
 * fails partway, the user is left with a partial opening and must delete it
 * (`deleteBoxOpening`) and retry.
 */
export async function openBox(params: {
  openedAt: string                                          // 'yyyy-MM-dd' — drives the new lots' purchase_date
  sourceLotId: string
  /** Units of the source lot being opened (usually 1). */
  quantity: number
  allocationMethod: 'relative_fmv' | 'specific_id' | 'equal'
  notes?: string | null
  cards: Array<{
    itemId?: string | null                                  // null => create new item
    newItemName?: string | null
    newItemCategory?: string | null
    basis: number                                            // computed per-card $ (already allocated)
  }>
}): Promise<{ boxOpeningId: string; lotIds: string[] }> {
  if (!(params.quantity > 0)) throw new Error('Quantity to open must be greater than 0')
  if (params.cards.length === 0) throw new Error('Add at least one card')
  for (const c of params.cards) {
    if (!c.itemId && !c.newItemName?.trim()) throw new Error('Each card needs an item or a new item name')
  }

  const user_id = await getUserId()

  // ── 1. Lock in the source lot's cost and deplete it ────────────────────────
  const { data: sourceLot, error: sourceErr } = await supabase
    .from('inventory_lots')
    .select('id, item_id, transaction_id, unit_cost, quantity_remaining, items(name)')
    .eq('id', params.sourceLotId)
    .is('deleted_at', null)
    .single()
  if (sourceErr || !sourceLot) throw sourceErr ?? new Error('Source lot not found')
  if (params.quantity > sourceLot.quantity_remaining) {
    throw new Error(`Only ${sourceLot.quantity_remaining} unit(s) of this box remain — can't open ${params.quantity}`)
  }

  const boxCost = Number((sourceLot.unit_cost * params.quantity).toFixed(2))
  const allocatedTotal = params.cards.reduce((s, c) => s + c.basis, 0)
  if (Math.abs(allocatedTotal - boxCost) > 0.01) {
    throw new Error(`Allocated basis (${allocatedTotal.toFixed(2)}) doesn't match box cost (${boxCost.toFixed(2)})`)
  }

  const { error: depleteErr } = await supabase
    .from('inventory_lots')
    .update({ quantity_remaining: sourceLot.quantity_remaining - params.quantity })
    .eq('id', params.sourceLotId)
  if (depleteErr) throw depleteErr

  // ── 2. box_openings audit row ──────────────────────────────────────────────
  const boxName = (sourceLot.items as unknown as { name: string } | null)?.name ?? 'Box'
  const { data: opening, error: openingErr } = await supabase
    .from('box_openings')
    .insert({
      user_id,
      opened_at: params.openedAt,
      box_name: params.quantity > 1 ? `${boxName} ×${params.quantity}` : boxName,
      box_cost: boxCost,
      transaction_id: sourceLot.transaction_id ?? null,
      allocation_method: params.allocationMethod,
      source_lot_id: params.sourceLotId,
      quantity: params.quantity,
      notes: params.notes ?? null,
    })
    .select('id')
    .single()
  if (openingErr || !opening) throw openingErr ?? new Error('Failed to create box_openings row')

  // ── 3. One lot per card ────────────────────────────────────────────────────
  const lotIds: string[] = []
  for (const c of params.cards) {
    let itemId = c.itemId
    if (!itemId) {
      const { data: newItem, error: newItemErr } = await supabase
        .from('items')
        .insert({ user_id, name: c.newItemName!.trim(), category: c.newItemCategory ?? null })
        .select('id')
        .single()
      if (newItemErr || !newItem) throw newItemErr ?? new Error('Failed to create item')
      itemId = newItem.id
    }

    const { data: lotRow, error: lotErr } = await supabase
      .from('inventory_lots')
      .insert({
        user_id,
        item_id: itemId,
        transaction_id: sourceLot.transaction_id ?? null,
        box_opening_id: opening.id,
        quantity_purchased: 1,
        quantity_remaining: 1,
        unit_cost: c.basis,
        initial_unit_cost: c.basis,
        purchase_date: params.openedAt,
      })
      .select('id')
      .single()
    if (lotErr || !lotRow) throw lotErr ?? new Error('Failed to create card lot')

    // Only mirror a funding link if the source lot actually had one — nothing
    // to link to otherwise, and inventory_lot_transactions.transaction_id is
    // not nullable.
    if (sourceLot.transaction_id) {
      const { error: linkErr } = await supabase.from('inventory_lot_transactions').insert({
        user_id,
        lot_id: lotRow.id,
        transaction_id: sourceLot.transaction_id,
        allocated_amount: c.basis,
      })
      if (linkErr) throw linkErr
    }

    lotIds.push(lotRow.id)
  }

  return { boxOpeningId: opening.id, lotIds }
}

/**
 * Deletes a box-opening event: soft-deletes its resulting card lots (cascading
 * to their cost adjustments, same as `deleteLot`), restores the depleted
 * quantity back onto the source lot, and soft-deletes the box_openings row.
 *
 * No transaction to reverse — opening never created one, so there's nothing
 * to delete here (unlike `deleteLotCostAdjustment`, which does own its
 * transaction when it created one).
 *
 * Blocked if any resulting card has already been sold (quantity_remaining <
 * quantity_purchased) — same guard as `deleteTrade`, because reversing FIFO
 * depletion here would orphan a sale's COGS. Delete those sales first.
 */
export async function deleteBoxOpening(boxOpeningId: string): Promise<void> {
  const { data: opening, error: openingErr } = await supabase
    .from('box_openings')
    .select('id, source_lot_id, quantity')
    .eq('id', boxOpeningId)
    .single()
  if (openingErr || !opening) throw openingErr ?? new Error('Box opening not found')

  const { data: lots, error: lotsErr } = await supabase
    .from('inventory_lots')
    .select('id, quantity_purchased, quantity_remaining')
    .eq('box_opening_id', boxOpeningId)
    .is('deleted_at', null)
  if (lotsErr) throw lotsErr

  const sold = (lots ?? []).filter(l => l.quantity_remaining < l.quantity_purchased)
  if (sold.length > 0) {
    throw new Error(
      `${sold.length} card(s) from this box have already been sold. Delete those sales first, then delete the box opening.`
    )
  }

  const deleted_at = new Date().toISOString()

  for (const lot of lots ?? []) {
    const { error: adjErr } = await supabase
      .from('lot_cost_adjustments')
      .update({ deleted_at })
      .eq('lot_id', lot.id)
      .is('deleted_at', null)
    if (adjErr) throw adjErr
  }

  if ((lots ?? []).length > 0) {
    const { error: lotDelErr } = await supabase
      .from('inventory_lots')
      .update({ deleted_at })
      .eq('box_opening_id', boxOpeningId)
      .is('deleted_at', null)
    if (lotDelErr) throw lotDelErr
  }

  if (opening.source_lot_id) {
    const { data: sourceLot, error: sourceErr } = await supabase
      .from('inventory_lots')
      .select('quantity_remaining')
      .eq('id', opening.source_lot_id)
      .single()
    if (sourceErr) throw sourceErr
    if (sourceLot) {
      const { error: restoreErr } = await supabase
        .from('inventory_lots')
        .update({ quantity_remaining: sourceLot.quantity_remaining + opening.quantity })
        .eq('id', opening.source_lot_id)
      if (restoreErr) throw restoreErr
    }
  }

  const { error: openingDelErr } = await supabase
    .from('box_openings')
    .update({ deleted_at })
    .eq('id', boxOpeningId)
  if (openingDelErr) throw openingDelErr
}

// ─── Lot cost adjustments (capitalized basis) ─────────────────────────────────

/**
 * Recomputes a lot's `unit_cost` from its active adjustments and writes it.
 *
 * Reads the full adjustment set every time and rebuilds the number from
 * `initial_unit_cost` rather than nudging the stored value — see
 * `basisFromAdjustments` in lib/lotCost.ts for why incremental updates drift.
 *
 * `initial_unit_cost` is null on lots created before that column existed; those
 * have no adjustments yet, so the current `unit_cost` *is* the initial basis and
 * we backfill it on first touch.
 */
async function recomputeLotBasis(lotId: string): Promise<LotBasis> {
  const { data: lot, error: lotErr } = await supabase
    .from('inventory_lots')
    .select('id, unit_cost, initial_unit_cost, quantity_purchased')
    .eq('id', lotId)
    .single()
  if (lotErr) throw lotErr
  if (!lot) throw new Error('Lot not found')

  const initial = lot.initial_unit_cost ?? lot.unit_cost

  const { data: adjustments, error: adjErr } = await supabase
    .from('lot_cost_adjustments')
    .select('amount')
    .eq('lot_id', lotId)
    .is('deleted_at', null)
  if (adjErr) throw adjErr

  const basis = basisFromAdjustments(
    initial,
    lot.quantity_purchased,
    (adjustments ?? []).map(a => Number(a.amount)),
  )

  const { error: updErr } = await supabase
    .from('inventory_lots')
    .update({ unit_cost: basis.unitCost, initial_unit_cost: initial })
    .eq('id', lotId)
  if (updErr) throw updErr

  return basis
}

/**
 * Capitalizes a cost into a lot's basis — a grading fee, shipping the card to
 * the grader, or any other direct cost of preparing that item for sale.
 *
 * The transaction is either created or linked, never both:
 *  - `create` posts a `cost_of_goods` row (the fee was cash/manual, or hasn't
 *    synced). This is the Schedule C deduction.
 *  - `link` points at a transaction that already exists — typically the
 *    Plaid-synced charge from the grader. Posting another row here would
 *    deduct the same payment twice.
 *
 * Either way the lot's basis rises by `amount`; only the deduction's origin
 * differs. Schedule C reads transactions, profitability reads lot basis, so the
 * two tracks stay independent (see the design spec).
 */
export async function addLotCostAdjustment(params: {
  lotId: string
  adjustmentType: LotAdjustmentType
  /** Positive dollars. */
  amount: number
  incurredOn: string // 'yyyy-MM-dd'
  grader?: string | null
  gradeReceived?: string | null
  notes?: string | null
  /** Where the deduction comes from — an existing transaction, or a new one. */
  transaction:
    | { mode: 'link'; transactionId: string }
    | { mode: 'create'; merchant?: string | null }
}): Promise<{ adjustmentId: string; transactionId: string; basis: LotBasis }> {
  if (!(params.amount > 0)) throw new Error('Amount must be greater than 0')

  const user_id = await getUserId()

  let transactionId: string
  let createdTransaction = false

  if (params.transaction.mode === 'create') {
    const merchant = params.transaction.merchant?.trim()
      || params.grader?.trim()
      || ADJUSTMENT_LABELS[params.adjustmentType]
    const { data: txn, error: txErr } = await supabase
      .from('transactions')
      .insert({
        user_id,
        date: params.incurredOn,
        amount: -params.amount,
        merchant,
        type: 'other',
        source: 'manual',
        schedule_c_category: 'cost_of_goods',
        notes: params.notes ?? null,
      })
      .select('id')
      .single()
    if (txErr) throw txErr
    transactionId = txn.id
    createdTransaction = true
  } else {
    transactionId = params.transaction.transactionId
  }

  const { data: adjustment, error: adjErr } = await supabase
    .from('lot_cost_adjustments')
    .insert({
      user_id,
      lot_id: params.lotId,
      transaction_id: transactionId,
      created_transaction: createdTransaction,
      adjustment_type: params.adjustmentType,
      amount: params.amount,
      incurred_on: params.incurredOn,
      grader: params.grader?.trim() || null,
      grade_received: params.gradeReceived?.trim() || null,
      notes: params.notes?.trim() || null,
    })
    .select('id')
    .single()
  if (adjErr) throw adjErr

  const basis = await recomputeLotBasis(params.lotId)
  return { adjustmentId: adjustment.id, transactionId, basis }
}

/**
 * Removes a capitalized cost and drops the lot's basis back down.
 *
 * Deletes the linked transaction only when this adjustment created it —
 * removing an adjustment means "I recorded this cost wrong", so the row it
 * posted was wrong too. A transaction that was merely *linked* is left alone:
 * it's a real bank record that exists independently of this bookkeeping.
 */
export async function deleteLotCostAdjustment(adjustmentId: string): Promise<LotBasis> {
  const { data: adjustment, error: fetchErr } = await supabase
    .from('lot_cost_adjustments')
    .select('id, lot_id, transaction_id, created_transaction')
    .eq('id', adjustmentId)
    .single()
  if (fetchErr) throw fetchErr
  if (!adjustment) throw new Error('Adjustment not found')

  const { error: delErr } = await supabase
    .from('lot_cost_adjustments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', adjustmentId)
  if (delErr) throw delErr

  if (adjustment.created_transaction && adjustment.transaction_id) {
    // transactions are hard-deleted in this codebase (see deleteTransaction).
    const { error: txErr } = await supabase
      .from('transactions')
      .delete()
      .eq('id', adjustment.transaction_id)
    if (txErr) throw txErr
  }

  return recomputeLotBasis(adjustment.lot_id)
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

// ─── Receipts ─────────────────────────────────────────────────────────────────
// `receipts` is a private, user-scoped Supabase Storage bucket (already
// created for mobile — see docs/supabase-schema.md). `transactions.receipt_url`
// stores the storage *path*, not a public URL — `plaid_sync_transactions`
// already relies on this to `.remove()` receipts for deleted rows, so viewing
// one requires a signed URL (see `getReceiptSignedUrl`).

const RECEIPTS_BUCKET = 'receipts'

function receiptExt(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : 'bin'
}

/** Uploads a receipt file for a transaction that has none yet, and stores its path on the row. */
export async function uploadReceipt(transactionId: string, file: File): Promise<string> {
  const user_id = await getUserId()
  const path = `${user_id}/${transactionId}-${Date.now()}.${receiptExt(file.name)}`
  const { error: uploadErr } = await supabase.storage.from(RECEIPTS_BUCKET).upload(path, file)
  if (uploadErr) throw uploadErr
  const { error } = await supabase.from('transactions').update({ receipt_url: path }).eq('id', transactionId)
  if (error) {
    await supabase.storage.from(RECEIPTS_BUCKET).remove([path])
    throw error
  }
  return path
}

/** Uploads a new receipt in place of an existing one, then best-effort removes the old file. */
export async function replaceReceipt(transactionId: string, oldPath: string, file: File): Promise<string> {
  const newPath = await uploadReceipt(transactionId, file)
  await supabase.storage.from(RECEIPTS_BUCKET).remove([oldPath])
  return newPath
}

/** Clears the transaction's receipt and deletes the underlying storage object. */
export async function deleteReceipt(transactionId: string, path: string): Promise<void> {
  const { error } = await supabase.from('transactions').update({ receipt_url: null }).eq('id', transactionId)
  if (error) throw error
  await supabase.storage.from(RECEIPTS_BUCKET).remove([path])
}

/** Short-lived signed URL for viewing a receipt (bucket is private, no public URLs). */
export async function getReceiptSignedUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(RECEIPTS_BUCKET).createSignedUrl(path, 300)
  if (error) throw error
  return data.signedUrl
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

// ─── Bundle sales — one payout, several different items ───────────────────────

export interface RecordBundleSaleResult {
  bundleId: string
  saleIds: string[]
  /** item_ids that came back oversold — mirrors recordSale's non-fatal warning. */
  oversoldItemIds: string[]
}

/**
 * Records a multi-item bundle sale: one `sales` row per item (each FIFO-
 * depleted via the ordinary record_sale edge function, source='manual'), all
 * stamped with a shared `bundle_id`, plus exactly ONE payout/fee/shipping
 * transaction set for the combined order total.
 *
 * Deliberately does NOT call recordSale()/createSaleTransactions() per line —
 * that would create a payout/fee/shipping transaction for every item and
 * multiply the real order total by the line count. See the migration comment
 * in sale_bundles.sql for the full rationale.
 *
 * Oversold lines are non-fatal (matches recordSale's behavior): the sale still
 * records, flagged `inventory_status: 'oversold'` by record_sale itself, and
 * the caller decides how to warn.
 */
export async function recordBundleSale(params: {
  soldAt: string // 'yyyy-MM-dd'
  platform: string
  paymentMethod?: string | null
  externalOrderId?: string | null
  fees?: number | null
  shippingCost?: number | null
  notes?: string | null
  items: Array<{
    itemId: string
    itemName?: string | null
    quantity: number
    /** Line total (not per-unit) — matches recordSale's sale_price convention. */
    salePrice: number
  }>
}): Promise<RecordBundleSaleResult> {
  if (params.items.length < 2) {
    throw new Error('A bundle needs at least 2 items — use Record Sale for a single item')
  }

  const user_id = await getUserId()
  const soldAtIso = new Date(params.soldAt + 'T12:00:00').toISOString()

  const { data: bundle, error: bundleErr } = await supabase
    .from('sale_bundles')
    .insert({
      user_id,
      sold_at: params.soldAt,
      platform: params.platform,
      payment_method: params.paymentMethod ?? null,
      external_order_id: params.externalOrderId ?? null,
      fees: params.fees ?? 0,
      shipping_cost: params.shippingCost ?? null,
      notes: params.notes ?? null,
    })
    .select()
    .single()
  if (bundleErr || !bundle) throw bundleErr ?? new Error('Failed to create bundle')
  const bundleId: string = bundle.id

  const saleIds: string[] = []
  const oversoldItemIds: string[] = []
  for (const line of params.items) {
    const { data: saleData, error: saleErr } = await supabase.functions.invoke('record_sale', {
      body: {
        item_id: line.itemId,
        quantity: line.quantity,
        sale_price: String(line.salePrice),
        platform: params.platform,
        sold_at: soldAtIso,
        source: 'manual',
        external_order_id: params.externalOrderId ?? null,
      },
    })
    if (saleErr) throw saleErr
    if (saleData?.error) throw new Error(saleData.error)
    const saleId: string = saleData.sale_id
    if (!saleId) throw new Error('record_sale returned no sale_id')
    if ((saleData.unfulfilled_quantity ?? 0) > 0) oversoldItemIds.push(line.itemId)

    // bundle_id links this line to the order. fees/shipping/net_payout are
    // explicitly zeroed rather than left at record_sale's column default
    // (recordTrade does the same for its given-side sales) — there's no
    // principled per-line split of an order-level fee, so the Sales list
    // falls back to showing the line's own price as its net payout; the true
    // post-fee total lives only on the bundle.
    const { error: stampErr } = await supabase
      .from('sales')
      .update({
        bundle_id: bundleId,
        payment_method: params.paymentMethod ?? null,
        external_order_id: params.externalOrderId ?? null,
        fees: 0,
        shipping_cost: null,
        net_payout: line.salePrice,
      })
      .eq('id', saleId)
    if (stampErr) throw stampErr

    saleIds.push(saleId)
  }

  // One payout/fee/shipping transaction set for the whole order, tagged
  // related_bundle_id since no single line owns them.
  const totalPrice = params.items.reduce((s, l) => s + l.salePrice, 0)
  const merchantNames = params.items.map(l => l.itemName).filter(Boolean).join(', ')
  const merchant = merchantNames.length > 120 ? merchantNames.slice(0, 117) + '…' : (merchantNames || 'Bundle sale')
  const platformLabel = params.platform.charAt(0).toUpperCase() + params.platform.slice(1)

  const rows: Record<string, unknown>[] = [
    {
      user_id, date: params.soldAt, amount: totalPrice,
      merchant, type: 'other', source: 'manual',
      schedule_c_category: 'payout', related_bundle_id: bundleId,
    },
  ]
  if (params.fees && params.fees > 0) {
    rows.push({
      user_id, date: params.soldAt, amount: -params.fees,
      merchant: `${platformLabel} Fee`, type: 'fee', source: 'manual',
      schedule_c_category: 'commissions_fees', related_bundle_id: bundleId,
    })
  }
  if (params.shippingCost && params.shippingCost > 0) {
    rows.push({
      user_id, date: params.soldAt, amount: -params.shippingCost,
      merchant: 'Shipping', type: 'shipping', source: 'manual',
      schedule_c_category: 'shipping_postage', related_bundle_id: bundleId,
    })
  }
  const { error: txErr } = await supabase.from('transactions').insert(rows)
  if (txErr) throw txErr

  return { bundleId, saleIds, oversoldItemIds }
}

/**
 * Reverses every line's FIFO depletion (via reverse_sale, which also
 * soft-deletes each line and cleans up any per-line transactions), then
 * removes the bundle's own payout/fee/shipping transactions and soft-deletes
 * the bundle row.
 *
 * Simpler than deleteTrade: a bundle sale only depletes inventory, it never
 * creates lots, so there's no downstream-depletion check to run first.
 */
export async function deleteBundleSale(bundleId: string): Promise<void> {
  const { data: lines, error: linesErr } = await supabase
    .from('sales')
    .select('id')
    .eq('bundle_id', bundleId)
    .is('deleted_at', null)
  if (linesErr) throw linesErr

  for (const line of lines ?? []) {
    const { data, error } = await supabase.functions.invoke('reverse_sale', { body: { sale_id: line.id } })
    if (error) throw error
    if (data?.error) throw new Error(data.error)
  }

  const { error: txErr } = await supabase.from('transactions').delete().eq('related_bundle_id', bundleId)
  if (txErr) throw txErr

  const { error: bundleDelErr } = await supabase
    .from('sale_bundles')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', bundleId)
  if (bundleDelErr) throw bundleDelErr
}

/**
 * Edits a bundle's order-level fields and every line's own price/quantity.
 *
 * Line *item* is deliberately not editable here — swapping a line's item would
 * mean reversing that line's FIFO depletion and re-depleting a different
 * item's lots, which is a different shape of change (closer to delete-line-
 * then-add-line) than a plain field edit.
 *
 * Mirrors updateSale's shape: update the row(s), then sync only the
 * transactions that already exist by category (same limitation updateSale
 * has — adding a fee where none existed before doesn't create a new
 * transaction row).
 */
export async function updateBundleSale(params: {
  bundleId: string
  soldAt: string // 'yyyy-MM-dd'
  platform: string
  paymentMethod: string | null
  externalOrderId: string | null
  fees: number | null
  shippingCost: number | null
  notes: string | null
  lines: Array<{ id: string; quantity: number; salePrice: number }>
}): Promise<void> {
  const soldAtIso = new Date(params.soldAt + 'T12:00:00').toISOString()

  const { error: bundleErr } = await supabase
    .from('sale_bundles')
    .update({
      sold_at: params.soldAt,
      platform: params.platform,
      payment_method: params.paymentMethod,
      external_order_id: params.externalOrderId,
      fees: params.fees ?? 0,
      shipping_cost: params.shippingCost,
      notes: params.notes,
    })
    .eq('id', params.bundleId)
  if (bundleErr) throw bundleErr

  // Re-stamp every line's own copy of the order-level fields (recordBundleSale
  // stamps these at creation; they drive that line's badges in the Sales
  // list). fees/shipping_cost are NOT touched here — they stay 0/null on
  // every line, same as at creation.
  for (const line of params.lines) {
    const { error } = await supabase
      .from('sales')
      .update({
        quantity: line.quantity,
        sale_price: line.salePrice,
        sold_at: soldAtIso,
        platform: params.platform,
        payment_method: params.paymentMethod,
        external_order_id: params.externalOrderId,
        net_payout: line.salePrice,
      })
      .eq('id', line.id)
    if (error) throw error
  }

  // Sync the bundle's own linked transactions. Unlike updateSale (which only
  // ever updates rows that already exist), a bundle's fee/shipping row is
  // often ADDED for the first time on an edit — the bundle may have been
  // recorded with no fee at all, so there's nothing yet to update. Without
  // creating one, BundleDetailSlideOver's Schedule C card (which reads actual
  // transactions, not sale_bundles.fees/shipping_cost) would silently show
  // nothing even though the bundle row and every line's allocated share
  // already reflect the new amount.
  const { data: linked, error: fetchErr } = await supabase
    .from('transactions')
    .select('id, schedule_c_category, amount')
    .eq('related_bundle_id', params.bundleId)
    .eq('source', 'manual')
  if (fetchErr) throw fetchErr

  const user_id = await getUserId()
  const totalPrice = params.lines.reduce((s, l) => s + l.salePrice, 0)
  const platformLabel = params.platform.charAt(0).toUpperCase() + params.platform.slice(1)
  const byCategory = new Map((linked ?? []).map(tx => [tx.schedule_c_category, tx]))

  const payoutTx = byCategory.get('payout')
  if (payoutTx) {
    await supabase.from('transactions').update({ amount: totalPrice, date: params.soldAt }).eq('id', payoutTx.id)
  }

  async function syncCostRow(
    category: 'commissions_fees' | 'shipping_postage',
    value: number | null,
    merchant: string,
    type: string,
  ) {
    const existing = byCategory.get(category)
    if (value && value > 0) {
      if (existing) {
        await supabase.from('transactions').update({ amount: -value, date: params.soldAt }).eq('id', existing.id)
      } else {
        const { error } = await supabase.from('transactions').insert({
          user_id, date: params.soldAt, amount: -value,
          merchant, type, source: 'manual',
          schedule_c_category: category, related_bundle_id: params.bundleId,
        })
        if (error) throw error
      }
    } else if (existing) {
      // Edited down to zero/cleared — a $0 deduction isn't a real transaction.
      const { error } = await supabase.from('transactions').delete().eq('id', existing.id)
      if (error) throw error
    }
  }

  await syncCostRow('commissions_fees', params.fees, `${platformLabel} Fee`, 'fee')
  await syncCostRow('shipping_postage', params.shippingCost, 'Shipping', 'shipping')
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

export type PlaidExchangeResult =
  | {
      status: 'duplicate_detected'
      existing_item_id: string
      existing_institution_name: string
      matched_masks: string[]
      existing_item_status: 'active' | 'login_required' | 'error'
    }
  | {
      status: 'kept'
      institution_name: string | null
      warning?: 'login_required'
      message?: string
    }
  | {
      status: 'reconnected'
      success: true
    }
  | {
      success: true
      institution_name: string | null
      note?: string
    }

/**
 * Exchanges a Plaid Link public_token for an access_token and persists a plaid_items row
 * (or refreshes the existing one for update mode). Backend reads institution from metadata.
 */
export async function plaidExchangeToken(params: {
  public_token: string
  metadata?: unknown
  mode?: 'create' | 'update'
  /** update mode: the existing plaid_items.item_id being re-authenticated */
  item_id?: string
  /** create mode, second call: user's choice after duplicate_detected */
  choice?: 'keep' | 'fresh'
  /** create mode, second call: the item_id to keep or replace */
  existing_item_id?: string
}): Promise<PlaidExchangeResult> {
  const { data, error } = await supabase.functions.invoke('plaid_exchange_token', {
    body: params,
  })
  if (error) throw error
  return (data ?? {}) as PlaidExchangeResult
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

// ─── CSV Import / Settlement ──────────────────────────────────────────────────

export async function importMarketplaceCSV(
  platform: string,
  file: File,
): Promise<CSVImportResult> {
  const csvText = await file.text()
  const { data, error } = await supabase.functions.invoke('import_marketplace_csv', {
    body: { platform, csv_text: csvText },
  })
  if (error) throw error
  return data as CSVImportResult
}

export async function syncCSVOrders(platform: string): Promise<CSVSaleSyncResult> {
  const { data, error } = await supabase.functions.invoke('sync_csv_orders_to_sales', {
    body: { platform },
  })
  if (error) throw error
  return data as CSVSaleSyncResult
}

export async function markTransactionAsSettlement(
  id: string,
  platform: string,
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ record_type: 'settlement', schedule_c_category: 'settlement', platform })
    .eq('id', id)
  if (error) throw error
}

export async function linkCSVGroupToSettlement(
  groupId: string,
  settlementId: string,
  platform: string,
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ parent_settlement_id: settlementId })
    .eq('source', 'csv_import')
    .eq('platform', platform)
    .eq('csv_group_id', groupId)
  if (error) throw error
}

export async function unlinkCSVGroup(groupId: string, platform: string): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ parent_settlement_id: null })
    .eq('source', 'csv_import')
    .eq('platform', platform)
    .eq('csv_group_id', groupId)
  if (error) throw error
}
