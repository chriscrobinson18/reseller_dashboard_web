# Cross-cutting business logic

These rules are duplicated across multiple pages/functions rather than centralized — when you change one, grep for the others (each function below names its known siblings).

## "Is this transaction real business income/expense?" — the exclusion filter

Repeated (with slight variation) in `DashboardPage.tsx` (`computeKPIs`, `computeMonthlyChart`, `computeScheduleC`) and `ExpensesPage.tsx` (`uncategorized` count, `showSaleLinked` toggle). The shape is always:

```ts
if (t.record_type === 'settlement') return false      // settlements are a wrapper, not the real movement
if (t.net_zero_pair_id) return false                   // dashboard KPIs only — paired transfers cancel out
if (t.related_sale_id || t.source === 'csv_import') return false  // already counted via the Sale, don't double-count
const cat = getCategoryDef(t.schedule_c_category)
if (cat?.isExcluded) return false                      // transfer/personal/settlement/balance_adjustment categories
```

**Why `related_sale_id` / `csv_import` are excluded from transaction totals**: a sale's revenue/fees/shipping are already counted via `computeProfitability(sales)`. The payout/fee/shipping `transactions` rows that `recordSale` auto-creates (see below) exist so Expenses shows them and Schedule C category totals include them — but the Dashboard's *income/expense KPI* would double-count if it summed both the sale and its linked transactions, so it filters linked rows out. If you add a new aggregate, decide explicitly whether it should include sale-linked rows (Schedule C category totals: yes, via `computeScheduleC`, which only excludes settlements+csv_import — note it does NOT exclude `related_sale_id` rows) or KPI-style totals (no).

This inconsistency (KPIs exclude sale-linked rows by `related_sale_id`, but `computeScheduleC` doesn't) is the current actual behavior — verify against the live code before assuming one or the other when adding a new total.

## Recording a sale (`recordSale` in `mutations.ts`)

1. Calls the `record_sale` edge function → inserts the `sales` row, FIFO-depletes `inventory_lots.quantity_remaining` oldest-lot-first, writes `inventory_movements` audit rows. Returns `sale_id`, `inventory_status` (`ok`/`oversold`/`reconciled`), `unfulfilled_quantity`.
2. If `fees`/`shippingCost` were passed, the client computes `net_payout = sale_price - fees - shipping_cost` and `.update()`s the `sales` row directly — **this is client-computed, not server-computed**. `updateSale` later recomputes the same way on edit.
3. Calls `createSaleTransactions` → inserts up to 3 `transactions` rows, all tagged `related_sale_id: saleId`, `source: 'manual'`:
   - payout row: `amount: +salePrice`, category `payout`
   - fee row (if `fees > 0`): `amount: -fees`, category `commissions_fees`
   - shipping row (if `shippingCost > 0`): `amount: -shippingCost`, category `shipping_postage`

This is why a single "sale" shows up as one row in Sales but up to three rows in Expenses (visible there only when the "Sale rows" filter toggle is on).

## Editing a sale (`updateSale`)

Updates the `sales` row, recomputes `net_payout`. **Only for `source === 'manual'` sales**, it then re-fetches the linked transaction rows (`related_sale_id = id AND source = 'manual'`) and patches each one's `amount`/`date` to match, keyed by `schedule_c_category` (`payout` → sale price, `commissions_fees` → fees, `shipping_postage` → shipping). CSV-imported or Plaid-derived sales have no linked manual transactions to sync — editing those only touches the `sales` row.

## Deleting a sale (`deleteSale`)

Hard-deletes linked manual transactions (`related_sale_id = id AND source = 'manual'`), then soft-deletes the `sales` row (`deleted_at`). **Known bug** (TASKS.md P0): does not restore `quantity_remaining` on depleted lots or remove `inventory_movements` rows — stock counts become permanently understated after a sale is deleted. Don't copy this pattern for new delete flows; if you fix it, the fix belongs here and should also remove the matching `inventory_movements` rows.

## FIFO COGS computation

COGS for a sale = `sum(inventory_movements.quantity * inventory_movements.inventory_lots.unit_cost)` for that sale — computed identically in three places: `DashboardPage.computeProfitability`, `SalesPage.SaleDetail`, and (implicitly, lot-by-lot) the `TransactionInventorySection` component on the Expenses side. There is no single shared `computeCogs(sale)` helper — if you change the formula, update all three call sites or extract a shared helper into `mutations.ts`/`queries.ts` first.

`itemAvgCost` in `queries.ts` computes a **weighted-average** unit cost across an item's lots — this is for display only (Inventory page "Avg Cost" column); actual COGS accounting is always FIFO via `inventory_movements`, never the average.

## Revenue net of returns

`netRevenue = sale_price - (return_status === 'partial' ? refunded_amount : 0)`. Sales with `return_status === 'full'` are excluded entirely from revenue/profitability sums (`active = sales.filter(s => s.return_status !== 'full')`). This logic is duplicated in `DashboardPage.computeProfitability`, `SalesPage.SaleDetail`, and the `totalRevenue` calc in `SalesPage`.

## Period filtering

`getPeriodRange(preset)` in `periods.ts` returns `{ start, end }` as `'yyyy-MM-dd'` strings (or `{ null, null }` for `all_time`). Every page passes this into its own fetch function as `.gte('date'|'sold_at', start)` / `.lte(..., end)`. Transactions filter on `date`; sales filter on `sold_at` with `'T00:00:00Z'`/`'T23:59:59Z'` suffixes appended (since `sold_at` is a full timestamp, not just a date).
