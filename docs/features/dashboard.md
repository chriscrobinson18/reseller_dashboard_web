# Dashboard (`src/pages/DashboardPage.tsx`)

Read-only overview page. No mutations — purely fetches `transactions` + `sales` for the selected period and derives everything client-side.

## Data fetched

- `fetchTransactions(start, end)` — all columns, `.limit(5000)`, ordered by `date desc`. Local to this file (not shared with `ExpensesPage`'s identical-looking copy — see [architecture.md](../architecture.md) "Inconsistency to be aware of").
- `fetchSales(start, end)` — joins `items(id,name,category)` and `inventory_movements(id,quantity,inventory_lots(unit_cost,item_id))`, `.limit(2000)`, excludes soft-deleted.

## Derived sections (each a pure function over the fetched arrays — see [data-flows.md](../data-flows.md) for the shared exclusion-filter logic these all use)

All three transaction-aggregating functions (KPI row, Schedule C breakdown, monthly chart) share a single bucketing helper — `bucketTransaction(t)` in [`src/lib/categories.ts`](../../src/lib/categories.ts) — which decides per-row what bucket the transaction belongs to and what signed amount to add. See [categories.md](../categories.md#buckettransaction--single-bucketing-helper) for the rules. The display layer takes `abs()` only at render, so refunds posted to expense categories now correctly *reduce* the category total instead of inflating both sides.

1. **KPI row** (`computeKPIs`) — Total Income, Total Expenses, Net. Built on `bucketTransaction`: `income = Σ signedAmount over 'income' bucket`, `expenses = abs(Σ signedAmount over 'expense' bucket)`, `net = income − expenses`. Refunds-against-income subtract correctly; refunds-against-expense partially offset the expense total.
2. **Sales Profitability card** (`computeProfitability`) — Gross Revenue (net of partial-return refunds, full returns excluded), COGS (FIFO via `inventory_movements`), Gross Profit, Platform Fees, Shipping, Selling Margin = `grossProfit - fees - shipping`, with margin % shown when revenue > 0.
3. **Schedule C breakdown** (`computeScheduleC`) — sums `signedAmount` per `schedule_c_category` via `bucketTransaction`, grouped into Part I / Part II / Part III by each category's `scheduleLine`. Display takes `abs(total)` per expense line. Categories that hit the `null` bucket (settlements, sale-linked, csv_import, net-zero-paired, uncategorized, `isExcluded`) never appear.
4. **Monthly bar chart** (`computeMonthlyChart`, Recharts) — same `bucketTransaction` rules as KPIs, summed per `monthKey(date)` (`'yyyy-MM'`); bars use `incomeSum` and `abs(expenseSum)`.
5. **Uncategorized warning banner** — count of transactions with no `schedule_c_category` that aren't settlements/sale-linked/csv_import; links the user to Expenses to fix it (no direct categorize-from-Dashboard action).

## Period control

`PeriodPicker` drives a single `period` state (`PeriodPreset`, default `'ytd'`); both queries key off `getPeriodRange(period)` so changing the period refetches both transactions and sales.

## Things to know before changing this page

- All money math here is duplicated from (or duplicated *into*) `SalesPage.tsx` and `ExpensesPage.tsx` — check [data-flows.md](../data-flows.md) before "fixing" a calculation only here.
- This page has zero loading-state granularity beyond a single "Loading…" text next to the title; `loadingTx || loadingSales` gates nothing else (the page renders with empty arrays while loading, which can flash `$0.00` cards).

## Part III (Cost of Goods Sold) and inventory valuation — important constraint

The Sales Profitability card on the dashboard is **period-scoped**: it computes COGS by summing `inventory_movements.quantity × inventory_lots.unit_cost` for sales in the selected period. This is correct for "how profitable was Q1?" answers.

**The Schedule C Part III line is different.** The IRS formula is:

```
COGS = Beginning Inventory + Purchases − Ending Inventory
```

All three inputs are **full-tax-year values regardless of any dashboard period filter**. Beginning Inventory is what was on hand on Jan 1; Ending is what's on hand on Dec 31; Purchases is the year's `cost_of_goods` transaction total.

The planned `inventory_valuations(user_id, tax_year, beginning_inventory, ending_inventory)` table stores Beginning/Ending. A future "Part III card" on the dashboard must read from this table, NOT extend the period-scoped `computeProfitability` function.

P0 item 2: do not reuse `computeProfitability` for the Schedule C Part III line. If you do, switching the dashboard to a "Last 30 Days" period will silently compute the WRONG COGS for the tax year.
