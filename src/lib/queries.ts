import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { Item, InventoryLot, Trade, SaleBundle, PlaidItem, PlaidAccount, Transaction, BoxOpening, CSVGroup } from './types'
import type { CustomCategory } from './categories'
import { customCategoryValue } from './categories'
import type { ColorKey } from './categoryPalette'

export interface ItemWithLots extends Item {
  inventory_lots: InventoryLot[]
}

export async function fetchItemsWithLots(): Promise<ItemWithLots[]> {
  const { data, error } = await supabase
    .from('items')
    .select('*, inventory_lots(id, item_id, user_id, quantity_purchased, quantity_remaining, unit_cost, initial_unit_cost, transaction_id, trade_id, box_opening_id, purchase_date, created_at, deleted_at, inventory_lot_transactions(id, user_id, lot_id, transaction_id, allocated_amount, created_at), lot_cost_adjustments(id, user_id, lot_id, transaction_id, created_transaction, adjustment_type, amount, incurred_on, grader, grade_received, notes, created_at, deleted_at))')
    .is('deleted_at', null)
    .order('name')
  if (error) throw error
  // Soft-deleted rows are filtered here rather than in the query: PostgREST
  // can't filter an embedded resource without also dropping its parent.
  return ((data ?? []) as ItemWithLots[]).map(item => ({
    ...item,
    inventory_lots: (item.inventory_lots ?? [])
      .filter(l => !l.deleted_at)
      .map(l => ({
        ...l,
        lot_cost_adjustments: (l.lot_cost_adjustments ?? []).filter(a => !a.deleted_at),
      })),
  }))
}

export function useItems() {
  return useQuery({ queryKey: ['items'], queryFn: fetchItemsWithLots })
}

export function itemUnitsInStock(item: ItemWithLots): number {
  return (item.inventory_lots ?? []).reduce((s, l) => s + l.quantity_remaining, 0)
}

/** Weighted-average unit cost across an item's lots (FIFO is used for actual COGS). */
export function itemAvgCost(item: ItemWithLots): number {
  const lots = item.inventory_lots ?? []
  const totalQty = lots.reduce((s, l) => s + l.quantity_purchased, 0)
  if (totalQty === 0) return 0
  return lots.reduce((s, l) => s + l.unit_cost * l.quantity_purchased, 0) / totalQty
}

/** Single transaction by id. Not period-scoped, unlike the Expenses page fetch. */
export function useTransaction(id: string | null | undefined) {
  return useQuery({
    queryKey: ['transaction', id],
    enabled: !!id,
    queryFn: async (): Promise<Transaction> => {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('id', id!)
        .single()
      if (error) throw error
      return data as Transaction
    },
  })
}

/** Fetches several transactions by id — the funding sources behind one lot. */
export function useTransactionsByIds(ids: string[]) {
  const key = [...ids].sort().join(',')
  return useQuery({
    queryKey: ['transactions-by-ids', key],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Transaction[]> => {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .in('id', ids)
      if (error) throw error
      return (data ?? []) as Transaction[]
    },
  })
}

/**
 * Candidate purchase transactions for linking to an inventory lot: money-out
 * rows that are either uncategorized or already Cost of Goods. Rows firmly
 * categorized as something else are excluded as already-settled.
 *
 * Not period-scoped — a lot is often reconciled long after the purchase.
 */
export function useLotLinkCandidates(enabled: boolean) {
  return useQuery({
    queryKey: ['lot-link-candidates'],
    enabled,
    queryFn: async (): Promise<Transaction[]> => {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .lt('amount', 0)
        .or('schedule_c_category.is.null,schedule_c_category.eq.cost_of_goods')
        .order('date', { ascending: false })
        .limit(500)
      if (error) throw error
      return (data ?? []) as Transaction[]
    },
  })
}

/**
 * Fetches a trade with its linked given-side sales, received-side lots,
 * and transactions. Used by TradeDetailSlideOver.
 */
export function useTrade(id: string | null) {
  return useQuery({
    queryKey: ['trade', id],
    enabled: !!id,
    queryFn: async (): Promise<{
      trade: Trade
      givenSales: Array<{ id: string; quantity: number; sale_price: number; items: { id: string; name: string } | null }>
      receivedLots: Array<{ id: string; quantity_purchased: number; unit_cost: number; items: { id: string; name: string } | null }>
      incomeTransaction: { id: string; amount: number; schedule_c_category: string | null } | null
      cogsTransaction: { id: string; amount: number; schedule_c_category: string | null } | null
      cashTransaction: { id: string; amount: number; schedule_c_category: string | null } | null
    }> => {
      const { data: trade, error } = await supabase
        .from('trades')
        .select('*')
        .eq('id', id!)
        .is('deleted_at', null)
        .single()
      if (error || !trade) throw error ?? new Error('Trade not found')

      const [givenRes, lotsRes, txRes] = await Promise.all([
        supabase
          .from('sales')
          .select('id, quantity, sale_price, items(id, name)')
          .eq('trade_id', id!)
          .is('deleted_at', null),
        supabase
          .from('inventory_lots')
          .select('id, quantity_purchased, unit_cost, items(id, name)')
          .eq('trade_id', id!)
          .is('deleted_at', null),
        supabase
          .from('transactions')
          .select('id, amount, schedule_c_category')
          .eq('trade_id', id!),
      ])
      if (givenRes.error) throw givenRes.error
      if (lotsRes.error) throw lotsRes.error
      if (txRes.error) throw txRes.error

      const txs = txRes.data ?? []
      const typedTrade = trade as Trade
      return {
        trade: typedTrade,
        givenSales: (givenRes.data ?? []) as unknown as Array<{ id: string; quantity: number; sale_price: number; items: { id: string; name: string } | null }>,
        receivedLots: (lotsRes.data ?? []) as unknown as Array<{ id: string; quantity_purchased: number; unit_cost: number; items: { id: string; name: string } | null }>,
        incomeTransaction: txs.find(t => t.id === typedTrade.income_transaction_id) ?? null,
        cogsTransaction: txs.find(t => t.id === typedTrade.cogs_transaction_id) ?? null,
        cashTransaction: txs.find(t => t.id === typedTrade.cash_transaction_id) ?? null,
      }
    },
  })
}

/** All trades for the current user, newest-first. */
export function useTrades() {
  return useQuery({
    queryKey: ['trades'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trades')
        .select('id, traded_at, counterparty, given_fmv, received_fmv, cash_boot')
        .is('deleted_at', null)
        .order('traded_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as {
        id: string
        traded_at: string
        counterparty: string | null
        given_fmv: number | null
        received_fmv: number | null
        cash_boot: number | null
      }[]
    },
  })
}

/**
 * Fetches a box-opening event with the resulting card lots, the source lot it
 * was opened from, and its (already-deducted) purchase transaction, if any.
 * Used by BoxOpeningDetailSlideOver.
 */
export function useBoxOpening(id: string | null) {
  return useQuery({
    queryKey: ['box-opening', id],
    enabled: !!id,
    queryFn: async (): Promise<{
      opening: BoxOpening
      cards: Array<{ id: string; quantity_remaining: number; quantity_purchased: number; unit_cost: number; items: { id: string; name: string } | null }>
      sourceLot: { id: string; quantity_remaining: number; unit_cost: number; items: { id: string; name: string } | null } | null
      transaction: Transaction | null
      remainingBasis: number
    }> => {
      const { data: opening, error } = await supabase
        .from('box_openings')
        .select('*')
        .eq('id', id!)
        .is('deleted_at', null)
        .single()
      if (error || !opening) throw error ?? new Error('Box opening not found')

      const [lotsRes, sourceLotRes, txRes] = await Promise.all([
        supabase
          .from('inventory_lots')
          .select('id, quantity_remaining, quantity_purchased, unit_cost, items(id, name)')
          .eq('box_opening_id', id!)
          .is('deleted_at', null)
          .order('unit_cost', { ascending: false }),
        opening.source_lot_id
          ? supabase
              .from('inventory_lots')
              .select('id, quantity_remaining, unit_cost, items(id, name)')
              .eq('id', opening.source_lot_id)
              .single()
          : Promise.resolve({ data: null, error: null }),
        opening.transaction_id
          ? supabase.from('transactions').select('*').eq('id', opening.transaction_id).single()
          : Promise.resolve({ data: null, error: null }),
      ])
      if (lotsRes.error) throw lotsRes.error
      if (sourceLotRes.error) throw sourceLotRes.error
      if (txRes.error) throw txRes.error

      const cards = (lotsRes.data ?? []) as unknown as Array<{ id: string; quantity_remaining: number; quantity_purchased: number; unit_cost: number; items: { id: string; name: string } | null }>
      const remainingBasis = Math.max(
        0,
        Number(((opening.box_cost ?? 0) - cards.reduce((s, c) => s + c.unit_cost, 0)).toFixed(2)),
      )

      return {
        opening: opening as BoxOpening,
        cards,
        sourceLot: (sourceLotRes.data ?? null) as unknown as { id: string; quantity_remaining: number; unit_cost: number; items: { id: string; name: string } | null } | null,
        transaction: (txRes.data ?? null) as Transaction | null,
        remainingBasis,
      }
    },
  })
}

/** All box breakdowns for the current user, newest-first, with child lots and item names. */
export function useBoxOpeningsWithItems() {
  return useQuery({
    queryKey: ['box-openings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('box_openings')
        .select('id, box_name, opened_at, box_cost, status, inventory_lots(id, unit_cost, deleted_at, items(id, name))')
        .is('deleted_at', null)
        .order('opened_at', { ascending: false })
      if (error) throw error
      return (data ?? []).map(row => {
        const lots = ((row.inventory_lots ?? []) as unknown as {
          id: string
          unit_cost: number
          deleted_at: string | null
          items: { id: string; name: string } | null
        }[]).filter(l => !l.deleted_at)
        const pullCount = lots.length
        const allocated = lots.reduce((s, l) => s + l.unit_cost, 0)
        const remainingBasis = row.status === 'open' && row.box_cost !== null
          ? Math.max(0, Number(((row.box_cost) - allocated).toFixed(2)))
          : null
        return {
          id: row.id as string,
          box_name: row.box_name as string,
          opened_at: row.opened_at as string,
          box_cost: row.box_cost as number | null,
          status: row.status as 'open' | 'closed',
          lots,
          pullCount,
          remainingBasis,
        }
      })
    },
  })
}

/** Fetches a bundle sale with its line items and the bundle-level transactions. Used by BundleDetailSlideOver. */
export function useBundle(id: string | null) {
  return useQuery({
    queryKey: ['bundle', id],
    enabled: !!id,
    queryFn: async (): Promise<{
      bundle: SaleBundle
      lines: Array<{ id: string; quantity: number; sale_price: number; inventory_status: string; items: { id: string; name: string } | null }>
      transactions: Array<{ id: string; amount: number; schedule_c_category: string | null }>
    }> => {
      const { data: bundle, error } = await supabase
        .from('sale_bundles')
        .select('*')
        .eq('id', id!)
        .is('deleted_at', null)
        .single()
      if (error || !bundle) throw error ?? new Error('Bundle not found')

      const [linesRes, txRes] = await Promise.all([
        supabase
          .from('sales')
          .select('id, quantity, sale_price, inventory_status, items(id, name)')
          .eq('bundle_id', id!)
          .is('deleted_at', null),
        supabase
          .from('transactions')
          .select('id, amount, schedule_c_category')
          .eq('related_bundle_id', id!),
      ])
      if (linesRes.error) throw linesRes.error
      if (txRes.error) throw txRes.error

      return {
        bundle: bundle as SaleBundle,
        lines: (linesRes.data ?? []) as unknown as Array<{ id: string; quantity: number; sale_price: number; inventory_status: string; items: { id: string; name: string } | null }>,
        transactions: txRes.data ?? [],
      }
    },
  })
}

/** All bundle sales for the current user, newest-first, with derived item count and net payout. */
export function useBundles() {
  return useQuery({
    queryKey: ['bundles'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sale_bundles')
        .select('id, sold_at, platform, external_order_id, fees, shipping_cost, sales(id, sale_price, quantity, deleted_at)')
        .is('deleted_at', null)
        .order('sold_at', { ascending: false })
      if (error) throw error
      return (data ?? []).map(row => {
        const lines = ((row.sales ?? []) as { id: string; sale_price: number; quantity: number; deleted_at: string | null }[])
          .filter(s => !s.deleted_at)
        const itemCount = lines.length
        const itemsTotal = lines.reduce((s, l) => s + l.sale_price * l.quantity, 0)
        const netPayout = itemsTotal - (row.fees ?? 0) - (row.shipping_cost ?? 0)
        return {
          id: row.id as string,
          sold_at: row.sold_at as string,
          platform: row.platform as string | null,
          external_order_id: row.external_order_id as string | null,
          itemCount,
          netPayout,
        }
      })
    },
  })
}

/**
 * Fetches the user's custom Schedule C categories, including tombstoned rows.
 * Resolution helpers (resolveCategory) need tombstoned rows to render historical
 * transactions; pickers should filter via activeCustomCategories(customs).
 */
export function useCustomCategories() {
  return useQuery({
    queryKey: ['custom_categories'],
    queryFn: async (): Promise<CustomCategory[]> => {
      const { data, error } = await supabase
        .from('custom_categories')
        .select('id, name, color_key, parent_value, schedule_line, deleted_at')
        .order('name')
      if (error) throw error
      return (data ?? []).map(r => ({
        id: r.id,
        value: customCategoryValue(r.id),
        name: r.name,
        colorKey: r.color_key as ColorKey,
        parentValue: r.parent_value,
        scheduleLine: r.schedule_line,
        deletedAt: r.deleted_at,
      }))
    },
  })
}

/** Active (non-tombstoned) custom categories for picker UIs. */
export function activeCustomCategories(customs: CustomCategory[]): CustomCategory[] {
  return customs.filter(c => !c.deletedAt)
}

/** Lists the user's connected Plaid institutions. RLS scopes by user_id. */
export function usePlaidItems() {
  return useQuery({
    queryKey: ['plaid_items'],
    queryFn: async (): Promise<PlaidItem[]> => {
      const { data, error } = await supabase
        .from('plaid_items')
        .select('*')
        .order('institution_name', { ascending: true, nullsFirst: false })
      if (error) throw error
      return (data ?? []) as PlaidItem[]
    },
  })
}

/**
 * Lists Plaid accounts under one institution.
 *
 * `itemId` here is the Plaid-side string id (the `item_id` column on plaid_items and
 * plaid_accounts), NOT the DB row uuid. Pass `plaidItem.item_id`, not `plaidItem.id`.
 */
export function usePlaidAccounts(itemId: string | null) {
  return useQuery({
    queryKey: ['plaid_accounts', itemId],
    enabled: !!itemId,
    queryFn: async (): Promise<PlaidAccount[]> => {
      const { data, error } = await supabase
        .from('plaid_accounts')
        .select('id, user_id, item_id, account_id, name, mask, subtype, display_name, sync_enabled, created_at')
        .eq('item_id', itemId!)
        .order('name', { ascending: true, nullsFirst: false })
      if (error) throw error
      return (data ?? []) as PlaidAccount[]
    },
  })
}

/** box_openings rows that were created without a source_lot_id (e.g. via Apple Shortcut). */
export function useIncompleteBreakdowns() {
  return useQuery({
    queryKey: ['incomplete_breakdowns'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('box_openings')
        .select('id, box_name, quantity, opened_at')
        .is('source_lot_id', null)
        .is('deleted_at', null)
        .order('opened_at', { ascending: false })
      if (error) throw error
      return data as Array<{
        id: string
        box_name: string
        quantity: number
        opened_at: string
      }>
    },
  })
}

// ─── CSV Group helpers ────────────────────────────────────────────────────────

export function getTransferRow(g: CSVGroup): Transaction | undefined {
  return g.transactions.find(tx => tx.schedule_c_category === 'transfer')
}

export function getNonTransferRows(g: CSVGroup): Transaction[] {
  return g.transactions.filter(tx => tx.schedule_c_category !== 'transfer')
}

export function getExpectedDeposit(g: CSVGroup): number | undefined {
  const t = getTransferRow(g)
  return t !== undefined ? -t.amount : undefined
}

export function isLinkedGroup(g: CSVGroup): boolean {
  return g.transactions.some(tx => tx.parent_settlement_id != null)
}

export function getLinkedSettlementId(g: CSVGroup): string | undefined {
  return g.transactions.find(tx => tx.parent_settlement_id != null)?.parent_settlement_id ?? undefined
}

export function getNetTotal(g: CSVGroup): number {
  return getNonTransferRows(g).reduce((sum, tx) => sum + tx.amount, 0)
}

export function getAdjustedTotal(g: CSVGroup): number {
  return getNetTotal(g) + g.priorBalance
}

export function getClosingReserve(g: CSVGroup): number | undefined {
  const expected = getExpectedDeposit(g)
  return expected !== undefined ? getAdjustedTotal(g) - expected : undefined
}

export function buildCSVGroups(rows: Transaction[], platform: string): CSVGroup[] {
  // 1. Group rows by csv_group_id
  const map = new Map<string, Transaction[]>()
  for (const tx of rows) {
    if (!tx.csv_group_id) continue
    const arr = map.get(tx.csv_group_id) ?? []
    arr.push(tx)
    map.set(tx.csv_group_id, arr)
  }

  // 2. Build groups; sort oldest-first so we can propagate the balance chain
  const groups: CSVGroup[] = [...map.entries()].map(([groupId, transactions]) => ({
    groupId, platform, transactions, priorBalance: 0,
  }))
  groups.sort((a, b) => {
    const aDate = getTransferRow(a)?.date ?? a.transactions[0]?.date ?? ''
    const bDate = getTransferRow(b)?.date ?? b.transactions[0]?.date ?? ''
    return aDate.localeCompare(bDate)
  })

  // 3. Propagate closing reserve as priorBalance into the next group
  let carry = 0
  for (const g of groups) {
    g.priorBalance = carry
    carry = getClosingReserve(g) ?? 0
  }

  // 4. Return newest-first for display
  return groups.reverse()
}

export function useCSVGroups(platform: string) {
  return useQuery({
    queryKey: ['csv-groups', platform],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('source', 'csv_import')
        .eq('platform', platform)
        .not('csv_group_id', 'is', null)
        .order('date', { ascending: false })
      if (error) throw error
      return buildCSVGroups((data ?? []) as Transaction[], platform)
    },
  })
}
