export interface LotCostTier {
  quantity: number
  unitCost: number
}

/**
 * Splits a lot's total cost across its units so the tiers sum to the total
 * *exactly* in whole cents.
 *
 * Resellers enter what the receipt/bank transaction says ("3 for $10.00"), but
 * `inventory_lots.unit_cost` is per-unit 2dp money. $10.00 / 3 = $3.33 stores a
 * lot worth $9.99, which under-reports COGS by a penny and stops the purchase
 * from reconciling against the $10.00 transaction. Instead the remainder cents
 * are pushed onto the last units: 2 × $3.33 + 1 × $3.34 = $10.00.
 *
 * Each returned tier becomes its own `inventory_lots` row, since one row can
 * only carry a single unit_cost. Cheapest tier is first, so FIFO consumes the
 * base price before the rounded-up units.
 *
 * @param totalCost dollars; rounded to the nearest cent before splitting
 * @param quantity  unit count; must be > 0
 */
export function splitLotCost(totalCost: number, quantity: number): LotCostTier[] {
  if (!Number.isFinite(totalCost) || !Number.isFinite(quantity) || quantity <= 0) return []

  const totalCents = Math.round(totalCost * 100)
  const baseCents = Math.floor(totalCents / quantity)
  const roundedUp = totalCents - baseCents * quantity // how many units absorb an extra cent

  const tiers: LotCostTier[] = []
  if (quantity - roundedUp > 0) {
    tiers.push({ quantity: quantity - roundedUp, unitCost: baseCents / 100 })
  }
  if (roundedUp > 0) {
    tiers.push({ quantity: roundedUp, unitCost: (baseCents + 1) / 100 })
  }
  return tiers
}

/** Sum of a split, in dollars — equals the requested total by construction. */
export function tiersTotal(tiers: LotCostTier[]): number {
  return tiers.reduce((cents, t) => cents + Math.round(t.unitCost * 100) * t.quantity, 0) / 100
}
