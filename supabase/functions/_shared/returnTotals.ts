// Pure refund-total math for record_return (no Deno/npm imports, so the web
// app's Vitest can check it). Added 2026-11-23.
//
// Bug fixed: marketplace imports (eBay Order Earnings, TCGplayer) set
// sales.refunded_amount / return_status from the platform report WITHOUT a
// `returns` row (salesImport.ts). record_return then added the in-app
// return's refund on top, so processing the same refund in the app doubled it
// (e.g. a $270 sale showing $540 refunded, overstating Line 2).
//
// Rule: refunded_amount follows the in-app `returns` rows once any exist.
//   - First in-app return on a sale: reconcile with the imported figure:
//     max(imported refunded_amount, this refund). The platform report and
//     the in-app entry describe the same money, so they don't add.
//   - Later returns: previous returns' total + this refund.
// Quantities only come from `returns` rows (imports never set them).

export interface PriorReturn {
  quantity: number
  refund_amount: number
}

export interface ReturnTotals {
  refundedQty: number
  refundedAmt: number
  status: "full" | "partial"
}

const cents = (n: number | null | undefined) => Math.round(Number(n ?? 0) * 100)

/** Totals after recording one more return; throws if it exceeds the units sold. */
export function nextReturnTotals(
  sale: { quantity: number; refunded_amount: number | null },
  prior: PriorReturn[],
  quantity: number,
  refundAmount: number,
): ReturnTotals {
  const priorQty = prior.reduce((t, r) => t + Number(r.quantity ?? 0), 0)
  if (quantity > sale.quantity - priorQty) throw new Error("Refund exceeds sold quantity")
  const refundedQty = priorQty + quantity
  const amtCents = prior.length > 0
    ? prior.reduce((t, r) => t + cents(r.refund_amount), 0) + cents(refundAmount)
    : Math.max(cents(sale.refunded_amount), cents(refundAmount))
  return {
    refundedQty,
    refundedAmt: amtCents / 100,
    status: refundedQty >= sale.quantity ? "full" : "partial",
  }
}
