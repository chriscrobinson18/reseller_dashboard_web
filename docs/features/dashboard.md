# Dashboard (`src/pages/DashboardPage.tsx`)

Read-only overview page. No mutations — purely fetches `transactions` + `sales` + `sale_bundles` for the selected period and derives everything client-side. **Income comes from the Sales tab** (2026-11-09): `computeSalesIncome(sales, bundles)` ([`salesIncome.ts`](../../src/lib/salesIncome.ts)) feeds the KPI row, Schedule C Breakdown, monthly chart and both CSV exports. See [categories.md](../categories.md#sales-based-income-2026-11-09).

## Data fetched

> **Row cap (fixed 2026-11-10):** Supabase (PostgREST) returns at most **1000 rows per request** (`max_rows`), silently, whatever `.limit()` asks for. Every list fetch here now pages through [`fetchAllRows`](../../src/lib/fetchAll.ts) with a stable `…, id` order. Before the fix, a period with more than 1000 transactions (e.g. a full 2025 year, about 2,100 rows) only showed its most recent 1000, so the KPIs, Schedule C Breakdown, Part III purchases and both CSV exports for long periods were understated. Use `fetchAllRows` for any new list query that can exceed 1000 rows.

- `fetchTransactions(start, end)` — all columns, paged (`fetchAllRows`), ordered by `date desc, id`. Local to this file (not shared with `ExpensesPage`'s identical-looking copy — see [architecture.md](../architecture.md) "Inconsistency to be aware of").
- `fetchBundles(start, end)` — `sale_bundles` (fees, shipping_cost, sold_at…) in the period, non-deleted; bundle order-level fees/shipping count once.
- `fetchSales(start, end)` — joins `items(id,name,category)` and `inventory_movements(id,quantity,inventory_lots(unit_cost,item_id))`, paged, excludes soft-deleted.
- `useLotValuationData()` (`queries.ts`) — every live lot + every sale movement, for lot-based inventory on hand at any date (`partIII.ts`: `inventoryOnHandAsOf`, `inventoryChangeForPeriod`, `inventoryChangeByMonth`). Shared with the Part III card.

## Derived sections (each a pure function over the fetched arrays — see [data-flows.md](../data-flows.md) for the shared exclusion-filter logic these all use)

All three transaction-aggregating functions (KPI row, Schedule C breakdown, monthly chart) share a single bucketing helper — `bucketTransaction(t)` in [`src/lib/categories.ts`](../../src/lib/categories.ts) — which decides per-row what bucket the transaction belongs to and what signed amount to add. See [categories.md](../categories.md#buckettransaction--single-bucketing-helper) for the rules. The display layer takes `abs()` only at render, so refunds posted to expense categories now correctly *reduce* the category total instead of inflating both sides.

1. **KPI row** (`computeKPIs`) — Total Income, **Cost of Goods Sold**, Total Expenses, **Inventory on hand**, **Net**. Built on `bucketTransaction`.
   - **Expenses are operating costs only (2026-11-13).** The `cogs` bucket (inventory purchases) is no longer in Expenses, on the KPI row or in the Monthly Overview.
   - **Cost of Goods Sold** = purchases − (ending − beginning inventory) = beginning + purchases − ending, for the selected period. Beginning is the lot-based value on hand at the end of the day *before* the period starts (0 for All time). Ending is the value at the period end, capped at today. Both come from `inventoryChangeForPeriod` / `inventoryOnHandAsOf` in [`partIII.ts`](../../src/lib/partIII.ts), fed by the shared `useLotValuationData` hook (also used by the Part III card).
   - **Net** = income − cost of goods sold − expenses, so unsold stock is an asset, not a cost. `cashNet` (income − expenses − purchases, the old Net) is the Net card's sub-line. In a stocking-up year the two differ by the growth in inventory on hand.
   - It uses the inventory **change**, not just the ending value: stock on hand at the start was paid for and expensed in an earlier period.
   - Cross-check (2026-11-13, YTD): beginning + lots bought − ending agreed with the FIFO cost of goods on sales to within a few tens of dollars, so the lot data holds together.
   - **Known overstatement:** sales with no `item_id` never deplete lots, so their units still count as on hand (COGS understated, Net overstated). The page shows an amber warning with the count.
   - Refunds-against-income subtract correctly; refunds-against-expense partially offset expenses.
   - Management view only — the tax figure is Part III (full year), never this period number.
2. **Sales Profitability card** (`computeProfitability`) — Gross Revenue (net of partial-return refunds, full returns excluded), COGS (FIFO via `inventory_movements`), Gross Profit, Platform Fees, Shipping, Selling Margin = `grossProfit - fees - shipping`, with margin % shown when revenue > 0.
3. **Schedule C breakdown** (`computeScheduleC`) — sums `signedAmount` per `schedule_c_category` via `bucketTransaction`, grouped into Part I / Part II / Part III by each category's `scheduleLine`. Display takes `abs(total)` per expense line. Categories that hit the `null` bucket (settlements, sale-linked, csv_import, net-zero-paired, uncategorized, `isExcluded`) never appear.
4. **Monthly bar chart** (`computeMonthlyChart`, Recharts) — same `bucketTransaction` rules as KPIs, summed per `monthKey(date)` (`'yyyy-MM'`). Three bars: Income, **Cost of goods sold** (that month's purchases − that month's inventory change, from `inventoryChangeByMonth`), and Expenses (operating only). Months run contiguously from the period start (or earliest activity for All time) to the period end, so the monthly COGS sum to the KPI figure (the changes telescope; verified on live 2026 data). A month can show negative COGS if lots were entered with a purchase date in a different month than the purchase transaction.
5. **Uncategorized warning banner** — count of transactions with no `schedule_c_category` that aren't settlements/sale-linked/csv_import; links the user to Expenses to fix it (no direct categorize-from-Dashboard action).

## Period control

`PeriodPicker` drives a single `period` state (`PeriodPreset`, default `'ytd'`); both queries key off `getPeriodRange(period)` so changing the period refetches both transactions and sales.

## CSV export (two buttons)

The header has two export buttons — **Summary CSV** and **Transactions CSV** — both driven by [`src/lib/csvExport.ts`](../../src/lib/csvExport.ts) + `downloadCSV`, disabled when the period has no transactions.

### Transactions CSV (`buildScheduleCTransactionsCSV`)

The period's business transactions as a Schedule C ledger.

- **Scope — all business rows** (`scheduleCExportRows`): every fetched transaction EXCEPT `record_type === 'settlement'`, net-zero pairs, sale-derived rows (`isSaleDerivedTransaction`) and rows whose resolved category is `isExcluded`; **plus one Income row per sale** (Line 1 gross) with Expense rows for its fees (Line 10), platform postage (Line 27a) and refund (Line 2), and bundle-level fee/shipping rows. Uncategorized transactions are kept (labeled `Uncategorized`). Since 2026-11-09 the export and the Breakdown card use the same inclusion rules.
- **Sign convention:** `Amount` is always absolute; the `Type` column (`Income` / `Expense`) carries the direction. A `returns_allowances` refund (negative) exports as an `Expense`-direction row under the Returns & Allowances category. The meals 50% multiplier is **not** applied — a ledger shows the actual dollar amount.
- **Columns:** Date, Type, Category, Schedule C Line, Merchant, Platform, Gross Amount (`gross_amount` if present else abs amount), Amount, Notes. Rows sorted ascending by date; RFC-4180 quoting.

### Summary CSV (`buildScheduleCSummaryCSV` / `computeScheduleCSummary`)

The "form" view — one row per IRS Schedule C line with net profit at the bottom, preceded by a period + basis header.

- **Same source as the transaction export** (business transactions + sales), rolled up by Schedule C line; the header states the income basis ("From recorded sales") and the sale count, so the two files tie out — the one exception is Line 24b, where the summary shows the **50%-deductible** meals amount while the ledger shows the actual dollar amount.
- **Line mapping:** Line 1 gross receipts = Part I income **excluding** `returns_allowances`; Line 2 = returns & allowances (kept separate, never netted into Line 1 — 1099-K guardrail); Line 4 COGS; Lines 8–27a Part II expenses (nonzero only); Line 28 total expenses; Line 29 tentative profit; Line 30 home office (separate from Line 28); Line 31 net profit. `shipping_postage` + `other_expense` aggregate into Line 27a. Custom categories flow to their resolved line automatically.
- **COGS sourcing (chosen model):** Line 4 = the sum of `cost_of_goods` **transactions** — inventory *purchases* in the period, a cash-basis treatment — **not** the FIFO cost of items sold from `inventory_movements`. The CSV header states this basis. (Because `recordSale` posts no COGS transaction, FIFO COGS lives only on the `sales` table / Profitability card; sourcing the summary from transactions keeps it consistent with the transaction export.)
- **Uncategorized** business rows can't be placed on a form line, so they are summed into a trailing `Uncategorized — NOT included above` row rather than silently dropped from net profit.
- Both exports covered by `src/lib/__tests__/csvExport.test.ts`.

## Things to know before changing this page

- All money math here is duplicated from (or duplicated *into*) `SalesPage.tsx` and `ExpensesPage.tsx` — check [data-flows.md](../data-flows.md) before "fixing" a calculation only here.
- This page has zero loading-state granularity beyond a single "Loading…" text next to the title; `loadingTx || loadingSales` gates nothing else (the page renders with empty arrays while loading, which can flash `$0.00` cards).

## Part III (Cost of Goods Sold) — traditional method (built 2026-11-09)

Owner decision 2026-11-09: **traditional §471 inventory method.** The **Part III card** ([`PartIIICard.tsx`](../../src/components/PartIIICard.tsx)) has its own tax-year selector and is **independent of the period picker**: Part III is always a full tax year.

| Line | Source |
|---|---|
| 35 beginning inventory | `inventory_valuations` row for **tax_year − 1** (never stored separately, so it can't disagree with the prior year's ending) |
| 36 purchases | `cost_of_goods` transactions in the year, using exactly the Summary CSV's rules (`computeScheduleCSummary(...).purchases`) |
| 40 | 35 + 36 (lines 37–39 unused) |
| 41 ending inventory | `inventory_valuations` row for the tax year |
| 42 cost of goods sold | 40 − 41 → Schedule C **Line 4** |

Math: [`src/lib/partIII.ts`](../../src/lib/partIII.ts) (`computePartIII`). Values are entered per year in the card (`saveInventoryValuation` in mutations.ts; method = physical count / estimate / from inventory lots / from filed return, plus notes for the preparer). For the first tracked year, enter the prior year's ending value from the filed return (e.g. 2024's for 2025's beginning).

**Lot-based estimates (2026-11-13):** `inventoryOnHandAsOf(lots, movements, 'yyyy-12-31')` values lots acquired by that date (`purchase_date`, else `created_at`) at today's `unit_cost`, adding back units depleted by sales dated after it. When a year-end value isn't saved, the card now **shows this estimate on Line 35/41** (tagged *Estimate*, italic) and Line 42 is computed from it (`computePartIII(..., { beginning, ending })` → `beginningEstimated` / `endingEstimated`). A saved value always wins, estimates are never saved automatically, `complete` stays false, and the **Summary CSV uses saved values only**. For the current year the ending estimate is inventory on hand today. Estimates only count entered lots — e.g. the 2025 beginning estimate is ~$442 because few pre-2025 lots exist — so use the filed return for the earliest year.

**Summary CSV:** when the export period is **Last Year** (a full calendar year), `buildScheduleCSummaryCSV` receives `{ taxYear, valuations }`: Line 4 = Line 42, the Part III lines are printed, and the header states the traditional basis (and flags "INCOMPLETE" if a value is missing). Any other period exports purchases only, with a header note, because Part III is never period-scoped.

**The Sales Profitability card stays period-scoped FIFO** (`computeProfitability`) and must never feed Line 4 — switching the period would silently change a tax-year figure.

## Year-End Tie-Out

`TieOutCard` ([`src/components/TieOutCard.tsx`](../../src/components/TieOutCard.tsx)), below the Part III card. **Read-only completeness insurance** for sales-based income (owner decision 2026-11-09): it proves every sale is recorded by reconciling each channel's recorded sales with the money it paid out. Platform-by-platform background: [reconciliation.md](../reconciliation.md).

- **Own tax-year selector** (2025 → current year, defaults to the current year), **never period-scoped**, like Part III.
- **Data** ([`src/lib/tieOutData.ts`](../../src/lib/tieOutData.ts), all paged with `fetchAllRows`; takes the Supabase client as a parameter so the same queries run outside the browser, e.g. under Vitest against live data):
  - the year's non-deleted sales (all columns, incl. `payment_method` / `payments`)
  - settlement deposits: `record_type = 'settlement'` or category `settlement`, amount > 0, source not `csv_import`, **not** linked to a sale or bundle (a sale's own payout row re-tagged `settlement` is not a bank deposit)
  - the prior year's sales and deposits for the payout-timing platforms (carry-in)
  - eBay / Amazon report rows (`csv_import`) and their settlement deposits, ±31 days around the year (for payout matching across New Year)
  - bank/card/manual rows mentioning eBay or Amazon (for the ghost check)
  - income-tagged (`payout`) deposits, and eBay Order Earnings sales + Transaction Report rows ±45 days (for the eBay source comparison)

### Platform table (`computeTieOut`, `src/lib/tieOut.ts`)

Per platform: sales count / net (each sale's stored `net_payout`, because platform formulas differ) vs settlement deposits, with month drill-down. Trade sales are skipped (non-cash).

- **Where a sale's money should land** (`tieOutTargets`): marketplaces under their own name; in-person venues (`IN_PERSON_PLATFORMS`: `manual`, Facebook Marketplace / Groups, Discord) under the rail in `payment_method` (`RAIL_DEPOSIT_PLATFORM`: PayPal / Venmo / Cash App / Zelle; **cash** expects no deposit); split payments divided by amount. In-person sales with no usable method stay under their platform and are flagged.
- **Strict platforms** (everything not listed below): flags for deposits with no recorded sales, months with deposits but no sales, a difference above the larger of $50 or 5% of sales net, and recorded sales with no deposits at all.
- **Payout-timing platforms** (`HELD_BALANCE_PLATFORMS`: eBay, Amazon, TCGplayer — used for eBay/Amazon only in a year with no imported report): no monthly flags; sales > deposits is a note; deposits > sales is a note when covered by last year's held balance (prior year's sales net − deposits, floored at 0) or in the first tracked year, and a flag beyond it (`judgeHeldBalance`).

### eBay and Amazon: report reconciliation (`computePlatformLedger`, `applyLedgers`)

Their reports are complete ledgers of the seller balance, so these rows are reconciled line by line instead of by timing. Clicking the row shows the bridge:

| Line | Source |
|---|---|
| Recorded sales net | Σ `saleNet` of the Sales tab |
| Sales tab vs report, per order | order rows (report rows carrying an order number, promoted-listing fees included, purchases excluded) − recorded net; listed per order (largest 100) |
| of which labels bought separately | labels the report bills with no order number (`separateLabels`): Order Earnings charges each to its order, so they offset the order difference; only `orderDifferenceAfterLabels` is flagged (over $5) |
| Not tied to an order | store subscription and other fees, labels bought separately, eBay funds purchases, **paid in from your card/bank** ("Charge for …" rows), holds & adjustments |
| Change in balance held on the platform | Σ every report row in the year, incl. payouts |
| **= Payouts in the report** | −Σ `transfer` rows (exact by construction) |
| Bank deposits | settlement deposits matched 1:1 to report payouts (`PAYOUT_MATCH`): exact amount within 30 days, then a bank amount up to $5 lower within 10 days (instant-transfer fee); unmatched deposits within a week of the report's first row are payouts of a pre-report balance |
| **Unexplained** | bank − report payouts, net of transfer fees and pre-report payouts; should be $0 |

**Ghost check.** Every report row without an order number must reach the books by some path, or it is listed under "Ghost rows" and flagged: labels (covered by the Sales tab), holds / balance adjustments (net zero), the eBay store subscription (on Schedule C), "Charge for …" rows (must match a `settlement` row on a card/bank within ±7 days), eBay funds purchases (must match a `cost_of_goods` row within ±7 days); anything else is a ghost. A charge and its reversal (same description, equal and opposite, ≤ 90 days apart) cancel.

Ledger flags replace the timing notes on those rows: ghosts, report payouts with no bank deposit, bank deposits not in the report, and order differences after labels. With no flags the row reads "Explained by the {platform} report".

### Other sections

- **Deposits still counted as income** (`incomeDepositsNeedingSales`): positive `payout` deposits not linked to a sale, bundle, trade or net-zero pair (normally empty since the 2026-11-10 re-tag).
- **eBay: Order Earnings vs Transaction Report** (`compareEbaySources(…, year)`): per order, gross / fees (incl. advertising) / labels / refunds, plus one-sided orders. Order Earnings is authoritative; the report under-reports labels billed separately.
- **Layout:** table from `md` up, stacked cards on phones ([mobile-layout.md](../mobile-layout.md)); the lists are collapsible.
- **Limits:** Amazon refunds are netted into `sale_price` by the Amazon sync (TASKS.md), and refunds of prior-year sales show as order differences (the Sales tab has no prior-year orders).
