import type { Sale } from './types'

export interface SaleProfit {
  cogs: number        // sum of movement.quantity * lot.unit_cost
  netRevenue: number  // sale_price minus refund (partial and full returns)
  /** Charges paid directly and attributed to the sale (transactions.profit_sale_id). */
  directCosts: number
  profit: number      // netRevenue - cogs - fees - shipping - directCosts
}

/**
 * Per-sale profitability used by the Sales detail panel.
 *
 * Subtracts refunded_amount from sale_price for partial AND full returns
 * (2026-11-23: the Sales detail panel, the only caller, showed a fully
 * refunded sale as if it had been paid). A full refund with the units still
 * out (buyer kept it / lost) therefore shows its real loss: −COGS − fees.
 * The Dashboard's computeProfitability excludes full returns on its own.
 */
export function saleProfit(sale: Sale): SaleProfit {
  const cogs = (sale.inventory_movements ?? []).reduce(
    (s, m) => s + m.quantity * (m.inventory_lots?.unit_cost ?? 0),
    0,
  )
  const refund = sale.return_status === 'partial' || sale.return_status === 'full' ? (sale.refunded_amount ?? 0) : 0
  const netRevenue = sale.sale_price - refund
  // Bundle lines carry fees=0/shipping=null (the real charge sits once on the
  // bundle), so fall back to the allocated share or every bundle line reports
  // profit as though the order were free to sell.
  const fees = sale.allocated_fees ?? sale.fees ?? 0
  const shipping = sale.allocated_shipping ?? sale.shipping_cost ?? 0
  // Costs paid directly from your own account (not deducted by the platform),
  // attributed via transactions.profit_sale_id. Profit view only.
  const directCosts = sale.direct_costs ?? 0
  const profit = netRevenue - cogs - fees - shipping - directCosts
  return { cogs, netRevenue, directCosts, profit }
}
