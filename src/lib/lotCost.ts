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

export interface LotBasis {
  /** All-in per-unit basis, rounded to the cent — what `unit_cost` stores. */
  unitCost: number
  /** Exact all-in cost of the whole lot. Never rounded away. */
  totalBasis: number
}

/**
 * The lot's basis with its cost adjustments (grading, shipping to the grader)
 * folded in:
 *
 *   unit_cost = (initial_unit_cost × qty + Σ amounts) / qty
 *
 * Always call this with the lot's *full* set of active adjustments and write
 * the result — never add or subtract a delta from the stored `unit_cost`.
 * Recomputing from the invariant is what keeps a lot that's been adjusted and
 * un-adjusted a dozen times landing back on exactly its original basis; an
 * incremental version accumulates a rounding error every trip.
 *
 * Rounding: `unitCost` is 2dp money, so for qty > 1 it can't always express the
 * true per-unit share — `unitCost × qty` may sit up to (qty − 1) cents below
 * `totalBasis`. That's why `totalBasis` is returned separately and shown in the
 * UI: it's the honest number. For the case this feature exists to serve —
 * grading one individually identified card, qty 1 — both are exact.
 *
 * @param initialUnitCost per-unit basis at lot creation, before adjustments
 * @param quantityPurchased units in the lot; must be > 0
 * @param adjustmentAmounts positive dollar amounts of the active adjustments
 */
export function basisFromAdjustments(
  initialUnitCost: number,
  quantityPurchased: number,
  adjustmentAmounts: number[],
): LotBasis {
  if (!Number.isFinite(initialUnitCost) || !Number.isFinite(quantityPurchased) || quantityPurchased <= 0) {
    return { unitCost: 0, totalBasis: 0 }
  }

  // Integer cents throughout, like splitLotCost — float dollars would reintroduce
  // exactly the drift this function exists to prevent.
  const initialCents = Math.round(initialUnitCost * 100) * quantityPurchased
  const adjustmentCents = adjustmentAmounts.reduce(
    (s, a) => s + (Number.isFinite(a) ? Math.round(a * 100) : 0),
    0,
  )
  const totalCents = initialCents + adjustmentCents

  return {
    unitCost: Math.round(totalCents / quantityPurchased) / 100,
    totalBasis: totalCents / 100,
  }
}
