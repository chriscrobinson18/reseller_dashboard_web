import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { Item, InventoryLot } from './types'

export interface ItemWithLots extends Item {
  inventory_lots: InventoryLot[]
}

export async function fetchItemsWithLots(): Promise<ItemWithLots[]> {
  const { data, error } = await supabase
    .from('items')
    .select('*, inventory_lots(id, item_id, user_id, quantity_purchased, quantity_remaining, unit_cost, transaction_id, created_at, deleted_at)')
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
