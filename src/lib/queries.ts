import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { Item, InventoryLot, Trade } from './types'

export interface ItemWithLots extends Item {
  inventory_lots: InventoryLot[]
}

export async function fetchItemsWithLots(): Promise<ItemWithLots[]> {
  const { data, error } = await supabase
    .from('items')
    .select('*, inventory_lots(id, item_id, user_id, quantity_purchased, quantity_remaining, unit_cost, transaction_id, trade_id, created_at, deleted_at)')
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
