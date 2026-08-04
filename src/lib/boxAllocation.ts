export type BoxAllocationMethod = 'relative_fmv' | 'specific_id' | 'equal'

export interface BoxCard {
  /** Relative weight (relative_fmv) or user-typed $ basis (specific_id). Ignored for equal. */
  value: number
}

export interface BoxAllocationResult {
  /** Per-card basis, dollars, same order/length as the input cards. Sums to boxCost exactly. */
  basis: number[]
  /** True when relative_fmv fell back to equal split because every weight was 0. */
  fellBackToEqual: boolean
}

/**
 * Splits a box's cost across the cards that came out of it.
 *
 * - `relative_fmv` — card_basis = box_cost × (card_weight / Σ weights). The
 *   standard relative-sales-value method for joint products from a common cost
 *   (Treas. Reg. §1.471-2(c); ASC 330-10-30) — card/coin/comic dealers' usual
 *   approach. Falls back to `equal` if every weight is 0 (e.g. a box of pure
 *   commons with no FMV entered).
 * - `equal` — box_cost / card count, same for every card.
 * - `specific_id` — the user's own $ entries, used as-is (validated to sum to
 *   boxCost by the caller before this runs; not re-validated here).
 *
 * Like `splitLotCost`, works in integer cents and pushes the leftover penny
 * remainder onto the trailing cards so the result always sums to `boxCost`
 * exactly — never leaves a cent unaccounted for on Schedule C.
 */
export function allocateBoxCost(
  boxCost: number,
  method: BoxAllocationMethod,
  cards: BoxCard[],
): BoxAllocationResult {
  if (cards.length === 0 || !Number.isFinite(boxCost) || boxCost <= 0) {
    return { basis: cards.map(() => 0), fellBackToEqual: false }
  }

  const totalCents = Math.round(boxCost * 100)

  if (method === 'specific_id') {
    // Trust the user's own dollar entries; round each to the cent.
    return { basis: cards.map(c => Math.round((c.value || 0) * 100) / 100), fellBackToEqual: false }
  }

  const weightSum = method === 'equal' ? 0 : cards.reduce((s, c) => s + (c.value > 0 ? c.value : 0), 0)
  const fellBackToEqual = method === 'relative_fmv' && weightSum <= 0

  if (method === 'equal' || fellBackToEqual) {
    return { basis: splitEvenly(totalCents, cards.length), fellBackToEqual }
  }

  // Largest-remainder method: each card's exact cent share, floored, then the
  // leftover cents (always < cards.length) go one-by-one to the cards with the
  // largest fractional remainder — the standard way to round a weighted split
  // without systematically favoring earlier or later entries.
  const exact = cards.map(c => (totalCents * Math.max(c.value, 0)) / weightSum)
  const floored = exact.map(Math.floor)
  let remainder = totalCents - floored.reduce((s, v) => s + v, 0)

  const order = exact
    .map((v, i) => ({ i, frac: v - floored[i] }))
    .sort((a, b) => b.frac - a.frac)

  const cents = [...floored]
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    cents[order[k].i] += 1
  }

  return { basis: cents.map(c => c / 100), fellBackToEqual: false }
}

/** Splits totalCents into n shares as evenly as possible, remainder to the trailing shares. */
function splitEvenly(totalCents: number, n: number): number[] {
  const base = Math.floor(totalCents / n)
  const extra = totalCents - base * n
  return Array.from({ length: n }, (_, i) => (base + (i >= n - extra ? 1 : 0)) / 100)
}
