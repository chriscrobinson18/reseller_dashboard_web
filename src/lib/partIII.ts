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
  beginningInventory: number      // Line 35 (stored; else the estimate; else 0)
  purchases: number               // Line 36 (positive magnitude)
  line40: number
  endingInventory: number         // Line 41 (stored; else the estimate; else 0)
  cogs: number                    // Line 42
  beginningSet: boolean
  endingSet: boolean
  /** Line 35 / 41 is a lot-based estimate standing in for a value not yet saved. */
  beginningEstimated: boolean
  endingEstimated: boolean
  /** Both inventory values are stored: Line 42 is final for filing. */
  complete: boolean
}

/**
 * Lot-based stand-ins (inventoryOnHandAsOf at Dec 31) for years with no saved
 * valuation. A saved value always wins — the estimate never overrides it and
 * is never saved automatically; `complete` stays false until both are saved.
 */
export interface PartIIIEstimates {
  beginning?: number
  ending?: number
}

export function computePartIII(
  taxYear: number,
  purchases: number,
  valuations: InventoryValuationRow[],
  estimates: PartIIIEstimates = {},
): PartIII {
  const find = (y: number) => valuations.find(v => v.tax_year === y)
  const begin = find(taxYear - 1)
  const end = find(taxYear)
  const beginningEstimated = !begin && estimates.beginning !== undefined
  const endingEstimated = !end && estimates.ending !== undefined
  const beginningInventory = begin ? Number(begin.ending_inventory) : (estimates.beginning ?? 0)
  const endingInventory = end ? Number(end.ending_inventory) : (estimates.ending ?? 0)
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
    beginningEstimated,
    endingEstimated,
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

// ─── Period inventory change (Dashboard KPI row) ─────────────────────────────

export interface PeriodInventory {
  /** On hand at the end of the day BEFORE the period starts (0 for all-time). */
  beginning: number
  /** On hand at the end of the period (capped at today). */
  ending: number
  /** ending − beginning: inventory bought in the period but not yet sold, net of older stock sold off. */
  change: number
  beginningAsOf: string | null
  endingAsOf: string
}

function dayBefore(ymd: string): string {
  const d = new Date(ymd.slice(0, 10) + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Lot-based inventory at both ends of a dashboard period, so the KPI row can
 * show profit on an inventory basis instead of cash:
 *
 *   net after inventory = cash net + (ending − beginning)
 *
 * which is the same as replacing period purchases with
 * beginning + purchases − ending (the Part III shape). Adding only `ending`
 * would be wrong: stock on hand at the start was paid for — and expensed — in
 * an EARLIER period, so it would be credited without its purchase.
 *
 * Management view only. The tax figure stays Part III (full year, stored
 * valuations) — see docs/features/dashboard.md.
 */
export function inventoryChangeForPeriod(
  lots: LotForValuation[],
  movements: MovementForValuation[],
  start: string | null,
  end: string | null,
  today: string,
): PeriodInventory {
  const endingAsOf = !end || end.slice(0, 10) > today ? today : end.slice(0, 10)
  const beginningAsOf = start ? dayBefore(start) : null
  const ending = inventoryOnHandAsOf(lots, movements, endingAsOf).value
  const beginning = beginningAsOf ? inventoryOnHandAsOf(lots, movements, beginningAsOf).value : 0
  return {
    beginning,
    ending,
    change: Math.round((ending - beginning) * 100) / 100,
    beginningAsOf,
    endingAsOf,
  }
}

/** Months 'yyyy-MM' from `from` through `to` inclusive (both 'yyyy-MM…'). */
export function monthKeysBetween(from: string, to: string): string[] {
  const out: string[] = []
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7))
  const endY = Number(to.slice(0, 4)), endM = Number(to.slice(5, 7))
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++; if (m > 12) { m = 1; y++ }
  }
  return out
}

/**
 * Inventory change per calendar month (end of month − end of prior month,
 * month end capped at `today`), for the Monthly Overview's cost-of-goods-sold
 * bars: COGS(month) = purchases(month) − change(month). The changes telescope,
 * so they sum to the whole period's change when months are contiguous.
 */
export function inventoryChangeByMonth(
  lots: LotForValuation[],
  movements: MovementForValuation[],
  months: string[],
  today: string,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const mk of months) {
    const start = `${mk}-01`
    if (start > today) continue
    const y = Number(mk.slice(0, 4)), m = Number(mk.slice(5, 7))
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    out[mk] = inventoryChangeForPeriod(lots, movements, start, lastDay, today).change
  }
  return out
}
