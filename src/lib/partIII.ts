/**
 * Schedule C Part III — Cost of Goods Sold, traditional (§471) method
 * (owner decision 2026-11-09). Always a FULL tax year: never feed it a
 * dashboard period (see docs/features/dashboard.md "Part III").
 *
 *   Line 35 beginning inventory  = prior year's stored ending value
 *   Line 36 purchases            = cost_of_goods transactions in the year
 *   Line 40                      = 35 + 36   (lines 37–39 not used)
 *   Line 41 ending inventory     = this year's stored ending value
 *   Line 42 cost of goods sold   = 40 − 41   → Schedule C Line 4
 *
 * Values come from `inventory_valuations` (one row per tax year).
 */

export interface InventoryValuationRow {
  tax_year: number
  ending_inventory: number
  method?: string | null
  notes?: string | null
}

export interface PartIII {
  taxYear: number
  beginningInventory: number      // Line 35 (0 when not set)
  purchases: number               // Line 36 (positive magnitude)
  line40: number
  endingInventory: number         // Line 41 (0 when not set)
  cogs: number                    // Line 42
  beginningSet: boolean
  endingSet: boolean
  /** Both inventory values are stored: Line 42 is final for filing. */
  complete: boolean
}

export function computePartIII(
  taxYear: number,
  purchases: number,
  valuations: InventoryValuationRow[],
): PartIII {
  const find = (y: number) => valuations.find(v => v.tax_year === y)
  const begin = find(taxYear - 1)
  const end = find(taxYear)
  const beginningInventory = begin ? Number(begin.ending_inventory) : 0
  const endingInventory = end ? Number(end.ending_inventory) : 0
  const p = Math.abs(purchases)
  const line40 = beginningInventory + p
  return {
    taxYear,
    beginningInventory,
    purchases: p,
    line40,
    endingInventory,
    cogs: line40 - endingInventory,
    beginningSet: !!begin,
    endingSet: !!end,
    complete: !!begin && !!end,
  }
}

// ─── Suggested ending inventory from lots ────────────────────────────────────

export interface LotForValuation {
  id: string
  quantity_remaining: number
  unit_cost: number
  purchase_date: string | null
  created_at: string
  deleted_at?: string | null
}

export interface MovementForValuation {
  inventory_lot_id: string
  quantity: number
  /** sold_at of the sale that depleted the lot (null if the sale is gone). */
  sold_at: string | null
}

/**
 * Cost of inventory on hand at the end of `asOf` (a 'yyyy-MM-dd' date), at
 * each lot's current unit_cost:
 *   for each live lot acquired on or before asOf (purchase_date, else created_at):
 *     units on hand then = quantity_remaining today
 *                        + units depleted by sales dated after asOf
 * Only as good as the lots entered: lots never recorded aren't counted, so
 * this is a SUGGESTION the owner confirms or overrides (count / estimate).
 */
export function inventoryOnHandAsOf(
  lots: LotForValuation[],
  movements: MovementForValuation[],
  asOf: string,
): { value: number; units: number; lotCount: number } {
  const soldAfter = new Map<string, number>()
  for (const m of movements) {
    if (!m.sold_at || m.sold_at.slice(0, 10) <= asOf) continue
    soldAfter.set(m.inventory_lot_id, (soldAfter.get(m.inventory_lot_id) ?? 0) + m.quantity)
  }
  let value = 0, units = 0, lotCount = 0
  for (const l of lots) {
    if (l.deleted_at) continue
    const acquired = (l.purchase_date ?? l.created_at).slice(0, 10)
    if (acquired > asOf) continue
    const qty = Math.max(0, (l.quantity_remaining ?? 0) + (soldAfter.get(l.id) ?? 0))
    if (qty === 0) continue
    value += qty * Number(l.unit_cost ?? 0)
    units += qty
    lotCount += 1
  }
  return { value: Math.round(value * 100) / 100, units, lotCount }
}
