# Dashboard (`src/pages/DashboardPage.tsx`)

Read-only overview page. No mutations — purely fetches `transactions` + `sales` + `sale_bundles` for the selected period and derives everything client-side. **Income comes from the Sales tab** (2026-11-09): `computeSalesIncome(sales, bundles)` ([`salesIncome.ts`](../../src/lib/salesIncome.ts)) feeds the KPI row, Schedule C Breakdown, monthly chart and both CSV exports. See [categories.md](../categories.md#sales-based-income-2026-11-09).

## Data fetched

> **Row cap (fixed 2026-11-10):** Supabase (PostgREST) returns at most **1000 rows per request** (`max_rows`), silently, whatever `.limit()` asks for. Every list fetch here now pages through [`fetchAllRows`](../../src/lib/fetchAll.ts) with a stable `…, id` order. Before the fix, a period with more than 1000 transactions (e.g. a full 2025 year, about 2,100 rows) only showed its most recent 1000, so the KPIs, Schedule C Breakdown, Part III purchases and both CSV exports for long periods were understated. Use `fetchAllRows` for any new list query that can exceed 1000 rows.

- `fetchTransactions(start, end)` — all columns, paged (`fetchAllRows`), ordered by `date desc, id`. Local to this file (not shared with `ExpensesPage`'s identical-looking copy — see [architecture.md](../architecture.md) "Inconsistency to be aware of").
- `fetchBundles(start, end)` — `sale_bundles` (fees, shipping_cost, sold_at…) in the period, non-deleted; bundle order-level fees/shipping count once.
- `fetchSales(start, end)` — joins `items(id,name,category)` and `inventory_movements(id,quantity,inventory_lots(unit_cost,item_id))`, paged, excludes soft-deleted.

## Derived sections (each a pure function over the fetched arrays — see [data-flows.md](../data-flows.md) for the shared exclusion-filter logic these all use)

All three transaction-aggregating functions (KPI row, Schedule C breakdown, monthly chart) share a single bucketing helper — `bucketTransaction(t)` in [`src/lib/categories.ts`](../../src/lib/categories.ts) — which decides per-row what bucket the transaction belongs to and what signed amount to add. See [categories.md](../categories.md#buckettransaction--single-bucketing-helper) for the rules. The display layer takes `abs()` only at render, so refunds posted to expense categories now correctly *reduce* the category total instead of inflating both sides.

1. **KPI row** (`computeKPIs`) — Total Income, **Cost of Goods Sold**, Total Expenses, **Inventory on hand**, **Net**. Built on `bucketTransaction`.
   - **Expenses are operating costs only (2026-11-13).** The `cogs` bucket (inventory purchases) is no longer in Expenses, on the KPI row or in the Monthly Overview.
   - **Cost of Goods Sold** = purchases − (ending − beginning inventory) = beginning + purchases − ending, for the selected period. Beginning is the lot-based value on hand at the end of the day *before* the period starts (0 for All time). Ending is the value at the period end, capped at today. Both come from `inventoryChangeForPeriod` / `inventoryOnHandAsOf` in [`partIII.ts`](../../src/lib/partIII.ts), fed by the shared `useLotValuationData` hook (also used by the Part III card).
   - **Net** = income − cost of goods sold − expenses, so unsold stock is an asset, not a cost. `cashNet` (income − expenses − purchases, the old Net) is the Net card's sub-line. YTD 2026 on live data: cash −$59,524 → Net +$10,460 (inventory +$69,983 since Dec 31).
   - It uses the inventory **change**, not just the ending value: stock on hand at the start was paid for and expensed in an earlier period.
   - Cross-check (YTD 2026): $42,609 + $101,299 lots bought − $112,593 = $31,316, vs $31,334 FIFO COGS on sales — within $18.
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

## Year-End Tie-Out (built 2026-11-10)

`TieOutCard` ([`src/components/TieOutCard.tsx`](../../src/components/TieOutCard.tsx)), below the Part III card. **Read-only completeness insurance** for sales-based income (owner decision 2026-11-09): if every sale is recorded, each platform's settlement deposits roughly equal the net of its recorded sales.

- **Own tax-year selector** (2025 → current year, defaults to the current year), **never period-scoped**, like Part III.
- **Data** ([`src/lib/tieOutData.ts`](../../src/lib/tieOutData.ts), all paged with `fetchAllRows`; takes the Supabase client as a parameter so the same queries can be run outside the browser):
  - the year's non-deleted sales
  - settlement deposits: `record_type = 'settlement'` or category `settlement`, amount > 0, source not `csv_import`
  - income-tagged (`payout`) deposits
  - eBay Order Earnings sales and eBay Transaction Report rows (`csv_import`), each fetched **±45 days** around the year so orders that straddle New Year pair up
- **Math** ([`src/lib/tieOut.ts`](../../src/lib/tieOut.ts), tests in `src/lib/__tests__/tieOut.test.ts`):
  - **Platform table** (`computeTieOut`): per platform, sales count / net (each sale's stored `net_payout`, because platform formulas differ) vs settlement deposits, and deposits − sales net. Trade sales are skipped (non-cash). Flags:
    - deposits with no recorded sales
    - months with deposits but no sales
    - a difference above the larger of $50 or 5% of sales net

    Tap a platform for its months (rows with deposits but no sales are highlighted).
  - **Deposits still counted as income** (`incomeDepositsNeedingSales`): positive `payout` bank deposits not linked to a sale, bundle, trade or net-zero pair. The owner rule: each needs matching sales recorded, then gets re-tagged `settlement`.
  - **eBay: Order Earnings vs Transaction Report** (`compareEbaySources(…, year)`): per order, gross / fees (incl. advertising) / labels / refunds, plus orders present on only one side. Orders are kept for the year by the Order Earnings sale date (report-only orders by their first report row). Order Earnings is authoritative for income; differences point to report files worth re-importing.
- **Layout:** table from `md` up, stacked cards on phones (see [mobile-layout.md](../mobile-layout.md)); the two lists are collapsible.
- **Limits:**
  - Manual sales have no deposit platform, so they can't be matched to wallet / P2P deposits automatically.
  - Wallet cash-outs (PayPal, Cash App) show as "deposits with no recorded sales" until Phase 3 records their sales.
  - Amazon refunds are netted into `sale_price` by the Amazon sync (TASKS.md).


**In-person sales and wallets (2026-11-13).** Sales on venues with no settlement of their own (`manual`, Facebook Marketplace/Groups, Discord — `IN_PERSON_PLATFORMS` in `tieOut.ts`) are filed under the rail they were paid through via `payment_method` (`tieOutTargets`): PayPal / Venmo / Cash App / Zelle go to that wallet's deposits; cash goes to a **Cash** row that expects no deposits; split payments are divided by amount. Before this every wallet showed "Deposits with no recorded sales" while the matching manual sales sat unmatched under `manual`. In-person sales with no usable payment method stay under their platform with a "set a payment method" flag.

**eBay and Amazon: full report reconciliation (2026-11-13).** Their imported reports (`csv_import` rows) are complete ledgers of the seller balance, including every payout (`transfer` rows), so nothing is written off as "held". `computePlatformLedger` (`tieOut.ts`, data from `fetchTieOutData`'s `ledgerRows` / `ledgerDeposits`, fetched with a 31-day margin) builds, per year:

| Line | Source |
|---|---|
| Recorded sales net | Σ `saleNet` of the Sales tab |
| Sales tab vs report, per order | report order rows (rows with an order id in `notes`, ads excluded) − recorded net, listed per order |
| Not tied to an order | ads (always here: eBay bills promoted listings separately), store subscription/fees, labels without an order id, other charges/credits, holds & adjustments |
| Change in balance held on the platform | Σ every report row in the year (incl. payouts) |
| **= Payouts in the report** | −Σ `transfer` rows — exact by construction |
| Bank deposits | settlement deposits, matched 1:1 to report payouts: exact amount within 30 days, then bank ≤ $5 less within 10 days (eBay's $2 instant-transfer fee); unmatched deposits within a week of the report's first row are payouts of a pre-report balance |
| **Unexplained** | bank − report payouts, net of transfer fees and pre-report payouts. Should be $0. |

Clicking the eBay/Amazon row shows this bridge, any unmatched payouts, and the per-order differences (largest 100). `applyLedgers` replaces those rows' timing notes with ledger flags: unmatched payouts, and order differences over $5. Live results: eBay 2025/2026 and Amazon 2025 unexplained **$0.00**; Amazon 2026 −$448.69 = report payouts of $416.75 (2026-01-20, no bank deposit found) and $31.94 (2026-06-23, in the bank but tagged `other_expense` with no platform). Order differences are mostly fees/labels booked differently by Order Earnings and the Transaction Report (e.g. a $38.83 below-standard fee and a $19.27 label on order 16-15242-54134), plus refunds of prior-year sales; cancelled orders net to the same on both sides. Since Schedule C fees come from the Sales tab, a persistent fee difference is worth checking.

**TCGplayer (no imported report)** keeps the payout-timing rule: no monthly flags; sales > deposits is a note; deposits > sales is checked against last year's held balance (`HELD_BALANCE_PLATFORMS`, `judgeHeldBalance`). eBay/Amazon fall back to the same rule in a year with no imported report.

**Also (2026-11-13):** a platform with sales but **no deposits** is now flagged (2025 TCGplayer had $2,531 of sales and no deposits, unflagged); deposit rows linked to a sale or bundle (`related_sale_id` / `related_bundle_id`) are excluded — two bundle payout rows recategorized to `settlement` had shown as $3,403 of "Unassigned" deposits; `psa` was added to `SALE_PLATFORMS` so PSA consignment sales can be recorded against PSA deposits. The card has **its own year selector** (defaults to the current year) — e.g. Goldin's only sale is in 2025.
