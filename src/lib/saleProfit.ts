import type { Sale } from './types'

export interface SaleProfit {
  cogs: number        // sum of movement.quantity * lot.unit_cost
  netRevenue: number  // sale_price minus refund (partial returns only)
  profit: number      // netRevenue - cogs - fees - shipping
}

/**
 * Per-sale profitability used by the Sales detail panel.
 *
 * For partial returns, subtracts refunded_amount from sale_price (the buyer kept
 * some items; we keep the kept portion of revenue). For full returns, callers
 * typically exclude the sale upstream; if they don't, we leave netRevenue equal
 * to sale_price (refunded_amount is the full sale_price so the dashboard's
 * computeProfitability filter handles full returns separately).
 */
/**
 * The sale's *cost component* movements — inventory consumed by the sale that
 * belongs to some other item than the one being sold (a remote included with a
 * VHS to raise its value).
 *
 * There's no flag for this: a component simply is a movement whose lot's
 * `item_id` differs from the sale's. Callers use it to label those rows, to
 * count them on the list, and to block partial returns (which reverse LIFO by
 * unit count and would restore the wrong item).
 */
export function costComponentMovements(sale: Sale) {
  return (sale.inventory_movements ?? []).filter(
    m => m.inventory_lots != null && m.inventory_lots.item_id !== sale.item_id,
  )
}

export function saleProfit(sale: Sale): SaleProfit {
  const cogs = (sale.inventory_movements ?? []).reduce(
    (s, m) => s + m.quantity * (m.inventory_lots?.unit_cost ?? 0),
    0,
  )
  const refund = sale.return_status === 'partial' ? (sale.refunded_amount ?? 0) : 0
  const netRevenue = sale.sale_price - refund
  // Bundle lines carry fees=0/shipping=null (the real charge sits once on the
  // bundle), so fall back to the allocated share or every bundle line reports
  // profit as though the order were free to sell.
  const fees = sale.allocated_fees ?? sale.fees ?? 0
  const shipping = sale.allocated_shipping ?? sale.shipping_cost ?? 0
  const profit = netRevenue - cogs - fees - shipping
  return { cogs, netRevenue, profit }
}
