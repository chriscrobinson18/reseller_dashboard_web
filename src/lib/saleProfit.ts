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
