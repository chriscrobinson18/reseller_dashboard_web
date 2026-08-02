# Reseller Dashboard (Web) — Task Tracker

_Created: June 23, 2026. Source of truth for porting the iOS app's feature set to web. Mobile's task history lives in `reseller_dashboard/TASKS.md` — this file inherits its priority order and tax-correctness findings, adapted for the web stack._

**Strategy:** web becomes the primary client going forward. Both apps share the same Supabase project/schema (`qmizmnbzergqbpgyqseg`), so backend logic (edge functions, RLS, categories) is already shared — this is a frontend rebuild, not a data-model migration. Fix tax-correctness bugs once, here, rather than porting them broken from mobile.

---

## ✅ Completed (current state)

### Foundation
- Vite + React + TypeScript + Tailwind, React Query for data fetching, Supabase JS client
- Login page, Supabase auth, RLS-scoped queries (same as mobile — no `user_id` filtering needed in client code)
- Layout shell with route navigation (Dashboard / Sales / Inventory / Expenses)

### Dashboard
- Period picker (preset ranges) driving all queries
- KPI row: Total Income / Total Expenses / Net
- Sales Profitability card: Revenue, COGS (via `inventory_movements` join), Gross Profit, Fees, Shipping, Selling Margin + margin %
- Schedule C breakdown (Part I / Part II / Part III) grouped by category
- Monthly income/expense bar chart (Recharts)
- Uncategorized transaction warning banner

### Expenses
- Transaction table with period filter, text search (merchant/notes), category filter dropdown, "Sale rows" toggle
- Slide-over detail panel: edit date/amount/merchant/direction (non-Plaid only), inline category dropdown, notes (autosave on blur), delete with confirm
- Read-only treatment for Plaid-sourced transactions (category/notes still editable)
- Manual transaction add modal
- Cost-of-Goods → inventory lot linking section (`TransactionInventorySection`) in detail panel
- Net-zero pair / settlement / sale-linked badges shown in detail view

### Sales
- Sales table with period filter, search (item/order ID/platform), platform + status badges
- Record Sale modal → calls `record_sale` edge function
- Edit Sale modal, Delete Sale (with confirm) — removes linked transactions
- Link-unlinked-sale-to-item modal
- Sale detail slide-over: profitability breakdown (Revenue/COGS/Fees/Shipping/Net Profit), inventory movements (FIFO) table, return info display

### Inventory
- Expandable item list with lot sub-rows, search, totals header (item count / units in stock / value)
- Add/Edit Item modals, Add/Edit/Delete Lot modals
- Per-lot "% sold" progress bar, "No purchase record" badge for unlinked lots, linked-transaction indicator
- **Capitalized cost adjustments** (2026-07-26) — grading / shipping-to-grader / other costs added to a lot's basis via `AddLotCostAdjustmentModal`, with a create-or-link toggle so a Plaid-synced grader fee isn't deducted twice. Expandable basis breakdown on lot rows. Implements the grading half of the box-opening spec; see [`docs/features/inventory.md`](docs/features/inventory.md#capitalized-cost-adjustments-grading-shipping-to-grader).
- [ ] **Open Box flow** — the other half of [that spec](docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md): one sealed-box purchase splits into many single-card lots with basis allocated by relative FMV (`box_openings` table, `openBox`, `OpenBoxModal`). Still a draft proposal — not built.

### Categories
- All 21 Schedule C categories ported from mobile (`src/lib/categories.ts`), including `meals` 50% multiplier flag and `isExcluded` flag for transfer/personal/settlement/balance_adjustment

---

## 🚨 P0 — Tax Correctness (port fixes, don't port the bugs)

_These bugs exist in mobile's codebase (see mobile TASKS.md "P0 — June 2026 Audit Additions" and "Architectural Review"). Web's category/totals logic is being written fresh right now — fix these as part of the initial build instead of inheriting them._

**All eight closed in the 2026-06-23 P0 tax-correctness pass — see [`docs/superpowers/specs/2026-06-23-p0-tax-correctness-design.md`](docs/superpowers/specs/2026-06-23-p0-tax-correctness-design.md).**

- [x] **`scheduleCTotals` sign handling** — `computeScheduleC` in `DashboardPage.tsx` currently does `Math.abs(t.amount) * mult` per category; verify refunds/credits in expense categories *reduce* the category total rather than adding to it. Sum signed amounts per category, `abs()` only at display time for expense lines. _Closed by `1bfb6af` (bucketTransaction helper), `c35e9af` (computeScheduleC), `889b4bd` (computeKPIs), `683340c` (computeMonthlyChart)._
- [x] **Part III scope mismatch** — `computeProfitability`/COGS is period-scoped but any future "Beginning/Ending Inventory" feature (see P2) must use full-tax-year values regardless of selected period, or the formula is IRS-incorrect. Design this correctly from the start — don't add a period-scoped Part III card. _Guardrails captured in `6a27abe` (docs + inline JSDoc on `computeProfitability`)._
- [x] **Custom categories must appear in Schedule C breakdown from day one** — `resolveCategory` + `DashboardPage`'s merged `allCategories` list deliver this. _Guardrails captured in `6a27abe`; closed by the Custom Categories shipping series (`7166b87`…`b6b38db`)._
- [x] **Returns vs. Line 1 netting** — when `record_return` / refund handling ships (see P1), split negative payout rows into a "Returns & Allowances" bucket in the Schedule C breakdown rather than silently netting into Part I gross revenue (1099-K mismatch risk). _`returns_allowances` category added in `b72a840`; design notes + Part I render TODO in `6a27abe`._
- [x] **`record_return`: fix cost basis + create refund transaction row** — same edge-function bugs as mobile (uses `salePrice` instead of lot `unit_cost` for cost restoration; no `transactions` row inserted for the refund). Fix in the shared edge function — benefits both clients. _Closed by `d9be641` (deployed as `record_return` v21; LIFO movement reversal restores original lots at lot.unit_cost; refund txn row inserted with `returns_allowances` category)._
- [x] **`record_sale`: accept and store fees/shipping_cost** — confirm the edge function actually persists `fees`/`shipping_cost` params (mobile found these were silently dropped). `RecordSaleModal`/`EditSaleModal` pass them — verify end-to-end. _Verified in `5c5b43e`: the function does NOT persist them; client wrapper writes them via follow-up update. Contract documented; Deno e2e test asserts both halves._
- [x] **`Sale.profit` partial return fix** — `SalesPage.tsx` `SaleDetail` already subtracts `refunded_amount` for partial returns (looks correct) — confirm this matches the edge function's `return_status` semantics and add a regression test once a test setup exists. _Closed by `0732034`: `saleProfit` helper extracted with Vitest fixture covering no-return, partial, and full-return paths._
- [x] **Deleting a sale doesn't reverse FIFO depletion** — `deleteSale` mutation (see `src/lib/mutations.ts`) needs to restore `quantity_remaining` on depleted lots and remove `inventory_movements` rows before soft-deleting, or stock counts are permanently understated. Same bug as mobile. _Closed by `5bd0fcc` (new `public.reverse_sale(uuid)` RPC + edge function, atomic transaction with FOR UPDATE locks) and `cf56399` (client `deleteSale` rewritten as a thin invoker)._

### Open — found 2026-07-25 in a live-data audit

_Not ported from mobile. These are actual defects in the production dataset, found while debugging a stale Plaid connection. Both affect filed numbers._

- [ ] **Duplicate transactions in the live dataset — overstates BOTH income and COGS** — a YTD scan found **74 duplicate groups / 92 extra rows** (grouping on date + merchant + amount + account):
  - **58 rows (41 groups) on AmEx** `••1000/••1004/••2003`, created 2026-07-25. Cause is understood: reconnecting AmEx produced a *new* `plaid_item`, and Plaid issues **new `plaid_transaction_id`s for the same real transactions** under a new item. `plaid_sync_transactions` dedupes with `onConflict: 'plaid_transaction_id'`, so it structurally cannot catch these. Re-importing history after any reconnect will do this again.
  - **34 rows (33 groups) are older and unexplained**, including on Capital One `••5071`, whose sync was never touched that day. **A second, unidentified duplication path exists.** Root-cause this before trusting any total.
  - Worst cluster: `2026-03-30` on `••1004` — `SHOPIFY RETAIL` payouts ×3 and ×4, `Topps`/`Topps Vault` charges ×7 and ×3 — roughly **$16.4k duplicated income and $22.9k duplicated COGS in one day**.
  - Cleanup is destructive and `transactions` are **hard-deleted with no `deleted_at`**. Plan: export candidates first; keep the copy carrying user work (category, notes, lot links) and delete bare ones; treat same-day-same-amount groups as *candidates for review*, never auto-delete — 6 identical `Topps Dev −$259.78` charges on one day are plausibly real for a card breaker.
- [ ] **22 uncategorized AmEx bill payments — latent double-deduction** — of 33 `AMERICAN EXPRESS` ACH rows paying the card from checking, 11 are correctly `Transfer` (excluded) and **22 are uncategorized**. A card bill payment is a liability transfer, not an expense. If those are ever given an expense category while the underlying card charges are also recorded, the same money is deducted twice. Set all 22 to `Transfer` after eyeballing that each really is a bill payment.
- [ ] **`record_sale`/`reverse_return` need redeploying — deleted lots stayed FIFO-eligible (found 2026-08-02)** — both edge functions' FIFO lot query never filtered `deleted_at is null`, and `deleteLot` never zeroes `quantity_remaining`. Found live: a deleted lot's wrong `unit_cost` was silently used as a new sale's COGS. Fixed in source (`supabase/functions/record_sale/index.ts`, `supabase/functions/reverse_return/index.ts`) but **not deployable from this session** — run `supabase functions deploy record_sale reverse_return`. Until deployed, don't delete a lot that still has `quantity_remaining > 0` for an item that has other sellable stock. See `docs/supabase-schema.md` Deployment note.

---

## 🔴 P1 — Core Feature Parity with Mobile

_Daily-workflow features mobile has that web doesn't yet. Ordered by how often they're used._

### Plaid (bank sync)
- [x] **Plaid Link for Web** integration — `react-plaid-link` (`usePlaidLink` in `SettingsPage.tsx`), both create mode (Connect Bank) and update mode (Reconnect, passing `item_id` to `plaid_create_link_token`). _Found already shipped while auditing this list 2026-07-25 — predates this session, no closing commit on hand, verified by reading the current code rather than by having built it._
- [x] **Manual sync trigger** — "Sync Now" / "Force Full Resync" buttons, calls `plaid_sync_transactions`. See [`docs/features/settings.md`](docs/features/settings.md#bank-connections). _Extended 2026-07-25 (`plaid_sync_transactions` v33): non-`PRODUCT_NOT_READY` errors used to be `console.error`-only while the response still said `success: true`, so a dead connection (AmEx, `ITEM_LOGIN_REQUIRED`) rendered a green "Connected" badge for 113 days. Now maps reconnect-class codes to `plaid_items.status='login_required'`, everything else to `'error'`, and returns warnings the client surfaces. Plus a `status`-independent "stale" badge keyed on `last_synced_at` age, which catches failure modes no error code classifies._
- [x] **Bank account management page** — per-institution card lists its accounts; per-account rename (`display_name`) and `sync_enabled` toggle; Disconnect via kebab → confirm → `plaid_remove_item`. See [`docs/features/settings.md`](docs/features/settings.md#per-account-controls). _Same caveat as Plaid Link above: predates this session, verified by reading current code, not by building it._
- [x] **Settings page** — exists at `/settings` (`SettingsPage.tsx`): Bank Connections + Custom Categories sections. See [`docs/features/settings.md`](docs/features/settings.md). CSV import and tax settings, named in this item's original scope, are NOT part of it — those stay open below under their own items.

- [ ] **Deploy `plaid_sync_transactions` v33** — the error-surfacing rewrite is committed but **not deployed**. Until it is, the next connection failure is exactly as silent as the 113-day AmEx outage that motivated it: Plaid errors stay `console.error`-only, the response still reports `success: true`, and the badge stays green. The client-side "stale" badge ships independently and does provide a backstop, but it reports the symptom a week late rather than the cause immediately. `supabase functions deploy plaid_sync_transactions`.
- [ ] **`plaid_exchange_token`: reset item status on update-mode reconnect** — a successful Link update-mode reconnect never writes `plaid_items.status` back to `'active'`, so the "Reconnect needed" badge persists until the *next* successful sync happens to clear it. Masked in practice by v33's success path, but it means the UI can tell the user to reconnect something they just reconnected. Documented as a known gap in [`docs/features/settings.md`](docs/features/settings.md#backend-dependencies).
- [ ] **Guard against duplicate connections re-importing history** — `a7919d2` fixed the *cause* of duplicate `plaid_items` (matching on `institution_id` alone, which never matches the `NULL` every pre-existing item has). It does **not** address what happens after: a replacement item re-pulls history under fresh `plaid_transaction_id`s that the `onConflict: 'plaid_transaction_id'` dedupe cannot see. Needs a content-level dedupe (date + amount + account + merchant) on import, or the duplicate-cleanup task above will recur on every reconnect.

### CSV Import
- [ ] **Marketplace CSV import UI** — eBay Transaction Report, Amazon Settlement/Transaction View, Mercari CSV; drag-and-drop or file input calling `import_marketplace_csv` edge function (already shared with mobile — v16)
- [ ] **Settlement Status view** — port of mobile's `SettlementStatusView`/`SettlementDetailView`: segmented platform picker, Needs Breakdown / Breakdown Imported sections, disbursement matching UI
- [ ] **CSV → Sales auto-sync** — verify `syncCSVOrdersToSales` (already runs server-side per mobile's notes) surfaces correctly in the web Sales table once CSV import ships

### Categorization
- [x] **Custom Schedule C categories** — Shipped 2026-06-25 (see [`docs/superpowers/specs/2026-06-25-custom-categories-design.md`](docs/superpowers/specs/2026-06-25-custom-categories-design.md)). Supabase-backed `custom_categories` table with hybrid tax mapping (parent_value inherits from a built-in, or schedule_line maps directly to a Schedule C line). Inline management via `ManageCategoriesModal` reachable from every category dropdown. Soft-delete tombstones keep historical math intact. _Closed by `7166b87`…`b6b38db`._
- [x] **Bulk categorize** — Shipped 2026-07-10. Checkbox column + select-all in the Expenses table; a floating bar assigns one category to all selected rows via a single `.in('id', ids)` update (`bulkUpdateCategory`). Trade-linked rows are excluded (locked category); selection resets on filter change. See [`docs/features/expenses.md`](docs/features/expenses.md#bulk-categorize).
- [ ] **Quick categorize from list** — inline category change without opening detail panel (web's `CategoryDropdown` already supports this from the table — confirm UX is on par)
- [ ] **Period chip filter + sort** in Expenses — mobile has Date/Amount/Merchant sort with asc/desc toggle and a richer period preset/account filter sheet; web only has the basic period picker + search + single category filter today

### Receipts
- [ ] **Receipt attachment** — file upload to the existing private `receipts` Supabase Storage bucket (already created for mobile, RLS user-scoped); inline preview + replace + delete in the transaction detail slide-over

### Returns
- [x] **Return/refund UI** — "Process Return" button in Sale detail calling `record_return` edge function. Shipped: `ProcessReturnModal` + `recordReturn` mutation wrapper (button hidden only for trade-linked sales, relabels to "Edit Return" once a return exists). Also shipped: editing a return (delete + re-record via new `reverse_return` edge function), an optional return-shipping-cost field on the return (seller-paid label cost, posted as a `shipping_postage` transaction), and Sales-tab Net Payout now sums all `related_sale_id`-linked transactions so refunds/return-shipping show up as a (often negative) net payout. **`reverse_return` and `record_return`'s new `return_shipping_cost` param are undeployed** — see `docs/supabase-schema.md` Deployment note. Design: [`docs/superpowers/specs/2026-07-10-returns-design.md`](docs/superpowers/specs/2026-07-10-returns-design.md).
- [ ] **CSV return reconciliation** — detect refund + return-shipping rows in imported eBay/Amazon transactions, match to sales by `external_order_id`, and route them through the same inventory-restoring `record_return` primitive (re-tagging existing CSV rows, not duplicating) via a review queue. Hybrid model chosen in the returns design doc; depends on "Marketplace CSV import" + "Settlement Status view" above.
- [ ] **Deploy return edge functions** — `reverse_return` (new) and `record_return`'s new `return_shipping_cost` param exist only as committed source; they are **not deployed**, so edit-return and the return-shipping field won't work against live data until someone runs `supabase functions deploy record_return reverse_return` (needs Supabase CLI + project access — not available in the web session that shipped the UI). Run the Deno e2e tests (`supabase/functions/record_return/index.test.ts`, `supabase/functions/reverse_return/index.test.ts`) against a local stack first. See `docs/supabase-schema.md` Deployment note.
- [ ] **Clean up `TODO(p1-returns)` markers in `DashboardPage.tsx`** — their premise ("when the refund UI ships, `returns_allowances` rows should visually subtract from Line 1 via `bucketTransaction`") is superseded: `record_return`'s refund row is sale-linked, so `bucketTransaction` excludes it, and the "Gross Receipts − Returns = Line 1" presentation now lives in the shipped Schedule C **Summary export** (`buildScheduleCSummaryCSV`, Line 1 / Line 2 split). Remove or re-point the inline markers; see the note in `docs/categories.md` "Returns & Allowances".

### Export
- [x] **CSV export** — Shipped 2026-07-10. Dashboard "Transactions CSV" button downloads the period's business transactions via `src/lib/csvExport.ts`. Scope = all business rows (strips `isExcluded` + settlement rows, keeps sale-linked + uncategorized); `abs()` amount + `Type` direction column; `Platform` + `Gross Amount` columns. Unit-tested. See [`docs/features/dashboard.md`](docs/features/dashboard.md#csv-export-two-buttons).
- [x] **Schedule C Summary export** — Shipped 2026-07-10. Dashboard "Summary CSV" button: one row per IRS line + net profit (`computeScheduleCSummary`/`buildScheduleCSummaryCSV`). Same all-business-row source as the transaction export (ties out); returns kept on Line 2 (not netted into Line 1); meals halved on Line 24b; COGS (Line 4) = `cost_of_goods` purchase transactions (cash-basis, stated in the CSV header) rather than FIFO cost-of-goods-sold; uncategorized rows reported separately. Unit-tested. See [`docs/features/dashboard.md`](docs/features/dashboard.md#summary-csv-buildschedulecsummarycsv--computeschedulecsummary).

### Settings / Misc
- [ ] **Marketplace OAuth connections** (eBay/Amazon) — port of `MarketplaceAccountsView`; web flow uses a standard OAuth redirect instead of `ASWebAuthenticationSession`
- [ ] **Merchant auto-categorization rules** — `category_rules` table (mobile backlog item, not yet built on either client); ship on web first since the UI is simpler as a settings table

---

## 🟠 P2 — Tax Compliance & Filing

_Same priority tier as mobile's P2 — port once the core workflow above is solid._

- [ ] **⚠️ BLOCKER: decide the inventory accounting method before building any Part III card** — the docs currently assert **two mutually exclusive methods**, and the choice determines whether the next item should be built at all:
  - [`docs/features/dashboard.md`](docs/features/dashboard.md) documents the **§471 capitalize** model — `COGS = Beginning + Purchases − Ending`, which *requires* per-tax-year inventory valuations.
  - The box-opening spec states NIMS **§471(c)** was adopted — deduct at the later of paid-or-sold, which **needs no inventory valuation at all**. That's the simplification §471(c) buys.

  Both put a cost in the same year as its sale, so neither is "wrong" — but implementing one while documenting the other guarantees an inconsistent Part III. If NIMS: **drop the `inventory_valuations` item below entirely** and show deductions by later-of-paid-or-used. If §471: build it, and rewrite the box-opening spec's premise. This is a filing-method question for whoever signs the return, not an implementation detail — get it answered, then write it down as the single source of truth. Worked example that surfaced it: a bag bought 2025 / sold 2026 cannot be both "COGS in 2025" and "carried in ending inventory 2025" — the latter is precisely the mechanism that defers the cost to 2026, and doing both double-deducts.
- [ ] **Inventory valuation (Beginning/Ending) stored in Supabase, not browser storage** — _blocked on the method decision above; delete this item outright if NIMS is confirmed._ Create `inventory_valuations` table (`user_id`, `tax_year`, `beginning_inventory`, `ending_inventory`) instead of repeating mobile's `UserDefaults`-only mistake (flagged as a systemic risk in mobile's audit); Part III card reads/writes here
- [ ] **Year-end inventory snapshot button** — "Use Current Inventory Value" pre-fill from `sum(quantity_remaining × unit_cost)`
- [ ] **Self-employment tax estimate** — SE tax widget (15.3% on net profit up to SS wage base) on Dashboard
- [ ] **1099-K reconciliation view** — enter 1099-K amounts per platform, compare to Part I breakdown by platform
- [ ] **Settlements warning on export** — block/warn CSV export if unbroken settlements exist in the period
- [ ] **COGS unlinked flag** — surface `cost_of_goods` transactions with no linked lot
- [ ] **Attach real cost transactions to a sale (many-to-many)** — a sale's true costs often arrive as *several separate charges*, not one number typed into the Record Sale modal. Shipping is frequently paid on its own (Pirate Ship, USPS, a label bought days later), and there can be more than one cost per sale. Today the only path is the single `shipping`/`fees` field on the sale, which auto-creates one `shipping_postage` transaction — meanwhile the real bank row syncs from Plaid unlinked, so the same postage can hit Line 27a twice and per-sale margin uses a typed estimate instead of what was actually paid.

  Wants a `sale_transactions` join table (`sale_id`, `transaction_id`, `allocated_amount`, `kind`) — **directly mirroring [`inventory_lot_transactions`](../supabase/migrations/20260724120000_lot_transaction_links.sql)**, which already solved the identical shape for lot funding, including the DB trigger that keeps a denormalized primary link in sync. Requirements:
  - Attach N cost transactions to one sale, and split one transaction across N sales (a single $38.77 Pirate Ship charge covering 3 orders).
  - Sources: a **Plaid-synced transaction** (pick from a candidate list, same UX as the lot funding picker) **or** an **eBay/Amazon CSV import** row.
  - Per-sale profit reads attached actuals in preference to the typed estimate; reuse the `allocated_*` read-time pattern already used for bundle lines.
  - Must not double-count: attaching a real bank row should supersede (or reconcile against) the auto-created manual `shipping_postage` row rather than adding to it.

  Blocks trustworthy per-sale margin and clean Line 27a.
- [ ] **Cash basis disclosure** — "Accounting Method: Cash Basis" note in a Tax Settings page and export header
- [ ] **Receipt coverage warning** — flag COGS transactions over a threshold with no receipt
- [ ] **Quarterly estimated tax calendar** — payment dates + estimated amounts based on YTD net profit

---

## 🟡 P3 — UX & Dashboard Polish

- [ ] **Inventory value at cost card** on Dashboard
- [ ] **Top selling items card** on Dashboard
- [ ] **Per-platform sales breakdown card** on Dashboard + filter in Sales table
- [ ] **Plaid webhooks** — `TRANSACTIONS` webhook instead of relying solely on manual/cron sync; web has no "background app refresh" excuse mobile has, so this matters more here. Distinct from and in addition to the `ITEM` webhook family (`ERROR`, `PENDING_EXPIRATION`, `USER_PERMISSION_REVOKED`, `LOGIN_REPAIRED`) — `TRANSACTIONS` alone would NOT have caught the AmEx incident referenced in the Manual sync trigger item above; only an `ITEM` webhook fires on an auth failure without the user pressing Sync. That's currently caught only by the stale-badge heuristic (days since last successful sync), which is reactive, not push-based.
- [ ] **Duplicate + anomaly detection** — flag same amount + merchant within 3 days. Concretely overdue: an AmEx reconnect on 2026-07-25 re-imported ~4 months of history under a new Plaid item id (see the `plaid_exchange_token` duplicate-connection fix in the Schema/Architecture notes below) and left **74 duplicate groups / 92 extra transaction rows** — 58 from that re-import, 34 pre-existing and unexplained. Not yet cleaned up; a candidate list (no deletions) was offered but not built.
- [ ] **Low stock alerts** — threshold per item, visual badge (no push notifications needed yet on web — start with in-app banner)
- [ ] **Realtime updates** — Supabase Realtime subscriptions on `transactions`/`sales` so multi-tab/multi-device usage doesn't need manual refresh (more valuable on web than mobile, since web users are more likely to have multiple tabs open)

---

## 🟢 P4 — Advanced Tax & Compliance

_Same items as mobile's P4 — lower priority, web-appropriate notes only where they differ._

- [ ] **Year-end close wizard**
- [ ] **Accountant export package** (zip: Schedule C summary PDF + transaction CSV + uncategorized list + unbroken settlements + COGS-without-receipt list) — easier to generate server-side (Supabase Edge Function) and download in browser than on mobile
- [ ] **Multi-year P&L comparison**
- [ ] **1099-NEC contractor tracking**
- [ ] **Retirement contribution estimate**
- [ ] **Home office deduction setup**
- [ ] **Vehicle expense method selector**
- [ ] **Loan interest split**
- [ ] **Mixed-use asset allocation**
- [ ] **Prior year amended return warning**

---

## 🔵 P5 — Future / Deferred

- [ ] **PayPal / Venmo / CashApp CSV import**
- [ ] **TCGPlayer CSV import**
- [ ] **Bank CSV import** (institutions not on Plaid)
- [ ] **Amazon / eBay API integration** (deferred per mobile's notes — Amazon's $1,400/yr dev fee; eBay is free, activate first when scaling)
- [ ] **Multi-user / shared business**
- [ ] **Responsive/mobile-web layout** — replaces the "iPad / Mac Catalyst" mobile backlog item; web is the new primary client, so a responsive layout for phone browsers matters more than a native tablet layout did

---

## 🔄 Trades v2 follow-ups

_Shipped in v1 (2026-06-24): `recordTrade`, `deleteTrade`, `RecordTradeModal`, `TradeDetailSlideOver`, trade-acquired lot marker, trade-leg sale marker, non-cash transaction badge. Items below are known gaps deferred from v1._

- [ ] **Atomic `recordTrade` edge function** — v1 is client-orchestrated; a mid-flight failure leaves partial state (orphaned `trades` row + some transactions/sales/lots). v2 candidate: move to a Postgres-transactional edge function with server-side rollback. Current workaround: surface the `tradeId` in the error toast so the user can manually invoke `deleteTrade`.
- [ ] **`updateTrade` mutation** — v1 workaround is delete + re-record. Implement a proper edit flow once the atomic edge function lands (edit = RPC that reverts and replays in one transaction).
- [ ] **Bank-balance / cash-flow view filtering `is_non_cash = false`** — no such view exists yet, but the `transactions.is_non_cash` flag is in place. When a cash-flow reconciliation page ships, filter to `is_non_cash = false` to exclude non-cash trade legs.
- [ ] **iOS UI parity for trades** — schema is additive; the iOS app reads `trades`, `sales.trade_id`, `inventory_lots.trade_id`, `transactions.is_non_cash` without breaking. No iOS trade UI is in scope for v1; add when iOS becomes active again.

## 🗄️ Schema/Architecture Notes Inherited from Mobile

_Carried over from mobile's "June 2026 Architectural Review" since both clients share the schema — fix once, both clients benefit:_

- [x] `inventory_lots` needs a `purchase_date` column (currently only has `created_at`) — blocks correct FIFO ordering for back-dated lot entries. _Closed 2026-07-24 (`purchase_date` migration + `AddLotModal`/`EditLotModal`). Also went further: `inventory_lot_transactions` join table (2026-07-25) lets one lot be funded by several transactions — the split-tender case a single `transaction_id` FK couldn't represent — with `inventory_lots.transaction_id` kept as a denormalized, trigger-maintained mirror for iOS. See [`docs/supabase-schema.md`](docs/supabase-schema.md#inventory_lot_transactions)._
- [ ] No inventory adjustment type for personal-use withdrawal / shrinkage (Schedule C Line 36 requires excluding these from COGS)
- [ ] No `quantity` column on `transactions` — root cause of CSV multi-unit sales hardcoding `quantity: 1`
- [ ] No `tax_profiles` table — Schedule C header fields, home office sqft, vehicle method scattered or missing entirely; prerequisite for multi-device + accountant export features
- [ ] No `sales_tax` column on `sales`/`transactions` — can't prove Line 1 excludes pass-through sales tax
- [ ] Verify RLS on `marketplace_connections.access_token`/`refresh_token` is service-role-only (security check, not yet confirmed on either client)
- [ ] Edge functions (`record_sale`, `record_return`, `import_marketplace_csv`, Plaid functions) are not in either repo — unversioned, unreviewable. Set up `supabase link` and commit `supabase/functions/` to this repo (or a shared backend repo if mobile is retired)
- [ ] No automated tests for Schedule C math on either client — add test coverage here as features are ported, rather than carrying the gap forward
