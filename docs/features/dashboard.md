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

## CSV export (two buttons)

The header has two export buttons — **Summary CSV** and **Transactions CSV** — both driven by [`src/lib/csvExport.ts`](../../src/lib/csvExport.ts) + `downloadCSV`, disabled when the period has no transactions.

### Transactions CSV (`buildScheduleCTransactionsCSV`)

The period's business transactions as a Schedule C ledger.

- **Scope — all business rows** (`scheduleCExportRows`): every fetched transaction EXCEPT `record_type === 'settlement'` and rows whose resolved category is `isExcluded` (Transfer / Personal / Settlement / Balance Adjustment + customs inheriting that flag). **Deliberately different from the Schedule C Breakdown card**, which routes through `bucketTransaction` and therefore drops sale-linked / `csv_import` rows. The export *keeps* those — that is where sales income and selling costs live — plus uncategorized rows (labeled `Uncategorized`) so nothing is silently dropped from an accountant-facing ledger.
- **Sign convention:** `Amount` is always absolute; the `Type` column (`Income` / `Expense`) carries the direction. A `returns_allowances` refund (negative) exports as an `Expense`-direction row under the Returns & Allowances category. The meals 50% multiplier is **not** applied — a ledger shows the actual dollar amount.
- **Columns:** Date, Type, Category, Schedule C Line, Merchant, Platform, Gross Amount (`gross_amount` if present else abs amount), Amount, Notes. Rows sorted ascending by date; RFC-4180 quoting.

### Summary CSV (`buildScheduleCSummaryCSV` / `computeScheduleCSummary`)

The "form" view — one row per IRS Schedule C line with net profit at the bottom, preceded by a period + basis header.

- **Same source as the transaction export** (all business rows), rolled up by Schedule C line, so the two files tie out — the one exception is Line 24b, where the summary shows the **50%-deductible** meals amount while the ledger shows the actual dollar amount.
- **Line mapping:** Line 1 gross receipts = Part I income **excluding** `returns_allowances`; Line 2 = returns & allowances (kept separate, never netted into Line 1 — 1099-K guardrail); Line 4 COGS; Lines 8–27a Part II expenses (nonzero only); Line 28 total expenses; Line 29 tentative profit; Line 30 home office (separate from Line 28); Line 31 net profit. `shipping_postage` + `other_expense` aggregate into Line 27a. Custom categories flow to their resolved line automatically.
- **COGS sourcing (chosen model):** Line 4 = the sum of `cost_of_goods` **transactions** — inventory *purchases* in the period, a cash-basis treatment — **not** the FIFO cost of items sold from `inventory_movements`. The CSV header states this basis. (Because `recordSale` posts no COGS transaction, FIFO COGS lives only on the `sales` table / Profitability card; sourcing the summary from transactions keeps it consistent with the transaction export.)
- **Uncategorized** business rows can't be placed on a form line, so they are summed into a trailing `Uncategorized — NOT included above` row rather than silently dropped from net profit.
- Both exports covered by `src/lib/__tests__/csvExport.test.ts`.

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
