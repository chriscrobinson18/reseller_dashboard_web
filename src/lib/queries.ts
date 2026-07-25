import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { Item, InventoryLot, Trade, SaleBundle, PlaidItem, PlaidAccount, Transaction } from './types'
import type { CustomCategory } from './categories'
import { customCategoryValue } from './categories'
import type { ColorKey } from './categoryPalette'

export interface ItemWithLots extends Item {
  inventory_lots: InventoryLot[]
}

export async function fetchItemsWithLots(): Promise<ItemWithLots[]> {
  const { data, error } = await supabase
    .from('items')
    .select('*, inventory_lots(id, item_id, user_id, quantity_purchased, quantity_remaining, unit_cost, transaction_id, trade_id, purchase_date, created_at, deleted_at, inventory_lot_transactions(id, user_id, lot_id, transaction_id, allocated_amount, created_at))')
    .is('deleted_at', null)
    .order('name')
  if (error) throw error
  return ((data ?? []) as ItemWithLots[]).map(item => ({
    ...item,
    inventory_lots: (item.inventory_lots ?? []).filter(l => !l.deleted_at),
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
