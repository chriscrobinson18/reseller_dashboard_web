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

### 🔎 New P0 items — 2026-07-10 compliance review

_Concurrency/atomicity gaps found in a fresh CPA-lens audit of the ledger, FIFO inventory, and Schedule C pipeline — see [`docs/superpowers/specs/2026-07-10-compliance-review-findings.md`](docs/superpowers/specs/2026-07-10-compliance-review-findings.md) (F-01–F-04) and the Schedule C completeness bug it surfaced (F-09, fixed by the companion [settlement reconciliation spec](docs/superpowers/specs/2026-07-10-settlement-reconciliation-design.md))._

- [ ] **REQ-01 — Lock inventory rows during FIFO depletion** — `record_sale` reads lots then updates them with no `FOR UPDATE` lock, unlike `reverse_sale`, which was specifically rebuilt to close this class of bug (its migration comment even says it locks lots to "serialize this RPC against a concurrent `record_sale`" — only fixing one side of the race). Two concurrent sales for the same item can double-deplete a lot or desync `inventory_movements` from actual stock removed. Port `record_sale`'s depletion loop to a locked RPC, same pattern as `reverse_sale`.
- [ ] **REQ-02 — Make `record_return` atomic and replay-safe** — currently six sequential, unguarded REST calls with no transaction and no idempotency guard; a partial failure can leave inventory restored but the refund never posted to Schedule C, or a retry can double-restore stock.
- [ ] **REQ-04 — Reconcile sale-quantity edits with FIFO** — `EditSaleModal`/`updateSale` let a user change a sale's quantity without touching `inventory_movements`/lot quantities, inflating reported gross profit. Either remove quantity from manual-sale edits (force delete + re-record) or run the delta through the same locked path as REQ-01.
- [ ] **REQ-09 — Fix Schedule C completeness for manually-recorded sales** — `bucketTransaction` unconditionally excludes any transaction with `related_sale_id` set, so sale revenue/fees/shipping never reach `computeScheduleC`'s Part I/Part II totals for anyone recording sales manually today — they only show up in the separate Profitability card. See the settlement reconciliation spec's "Convention change" section for the fix. Highest-leverage single fix here: it's blocking correct headline numbers right now, with no dependency on Plaid or CSV import.

---

## 🔴 P1 — Core Feature Parity with Mobile

_Daily-workflow features mobile has that web doesn't yet. Ordered by how often they're used._

### Plaid (bank sync)
- [ ] **Plaid Link for Web** integration — replaces mobile's LinkKit; same `plaid_create_link_token` / `plaid_exchange_token` edge functions, web uses `react-plaid-link` instead of the native SDK
- [ ] **Manual sync trigger** — "Sync Now" / "Force Full Resync" buttons (mirrors mobile's `BankAccountDetailView`), calls `plaid_sync_transactions`
- [ ] **Bank account management page** — list connected accounts, per-account sync toggle, disconnect with confirmation (port of `BankAccountDetailView` + `MarketplaceAccountsView` pattern)
- [ ] **Settings page** — currently doesn't exist on web at all; needed as the home for Plaid management, CSV import, category management, tax settings

### CSV Import
- [ ] **Marketplace CSV import UI** — eBay Transaction Report, Amazon Settlement/Transaction View, Mercari CSV; drag-and-drop or file input calling `import_marketplace_csv` edge function (already shared with mobile — v16)
- [ ] **Settlement Status view** — port of mobile's `SettlementStatusView`/`SettlementDetailView`: segmented platform picker, Needs Breakdown / Breakdown Imported sections, disbursement matching UI. Accounting model now speced in [`2026-07-10-settlement-reconciliation-design.md`](docs/superpowers/specs/2026-07-10-settlement-reconciliation-design.md) — build against that rather than re-deriving reconciliation logic from scratch.
- [ ] **CSV → Sales auto-sync** — verify `syncCSVOrdersToSales` (already runs server-side per mobile's notes) surfaces correctly in the web Sales table once CSV import ships

### Categorization
- [x] **Custom Schedule C categories** — Shipped 2026-06-25 (see [`docs/superpowers/specs/2026-06-25-custom-categories-design.md`](docs/superpowers/specs/2026-06-25-custom-categories-design.md)). Supabase-backed `custom_categories` table with hybrid tax mapping (parent_value inherits from a built-in, or schedule_line maps directly to a Schedule C line). Inline management via `ManageCategoriesModal` reachable from every category dropdown. Soft-delete tombstones keep historical math intact. _Closed by `7166b87`…`b6b38db`._
- [ ] **Bulk categorize** — multi-select rows in Expenses table + assign category to all selected at once (mobile has this via swipe; web should use checkbox column)
- [ ] **Quick categorize from list** — inline category change without opening detail panel (web's `CategoryDropdown` already supports this from the table — confirm UX is on par)
- [ ] **Period chip filter + sort** in Expenses — mobile has Date/Amount/Merchant sort with asc/desc toggle and a richer period preset/account filter sheet; web only has the basic period picker + search + single category filter today

### Receipts
- [ ] **Receipt attachment** — file upload to the existing private `receipts` Supabase Storage bucket (already created for mobile, RLS user-scoped); inline preview + replace + delete in the transaction detail slide-over

### Returns
- [ ] **Return/refund UI** — "Process Return" button in Sale detail calling `record_return` edge function (UI doesn't exist on either client yet for return entry — ship web-first since mobile's is also a TODO)

### Collectibles Workflows (card business core)

_A complete CPA-approved spec for the first two items already exists and was never linked here — see [`docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md`](docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md), status `Draft — awaiting user review` since 2026-06-23. Given the account's majority category is Collectibles (box breaks + raw-card grading), this is a build priority, not background research — the only remaining decisions are the 5 "Open questions for user review" at the bottom of that spec._

- [ ] **Ship Box Opening (relative-FMV allocation)** — per the existing spec: `box_openings` table, NIMS-based COGS timing (deduct at open, not at sale), relative-sales-value allocation across pulled cards.
- [ ] **Ship Grading cost capitalization** — per the existing spec: `lot_cost_adjustments` table, grading fees added to lot `unit_cost` instead of expensed as `supplies` (closes a live Schedule C misstatement risk: today's workaround expenses the fee once from the bank feed, then a second manual bump to `unit_cost` re-adds the same cost to COGS at sale time).
- [ ] **REQ-06 — Personal-use withdrawal adjustment (Line 36)** — pulling cards for a personal collection is a weekly event in this business; today deleting/shrinking a lot leaves the original purchase fully deducted as COGS with nothing subtracting the withdrawn basis, overstating COGS. Design as a companion to the box-opening spec's `lot_cost_adjustments` pattern (a negative adjustment type). See [`2026-07-10-compliance-review-findings.md`](docs/superpowers/specs/2026-07-10-compliance-review-findings.md) finding O-01.

### Sale Entry & Platforms
- [ ] **REQ-07 — Add `facebook` to the platform list** — `RecordSaleModal`/`EditSaleModal` platform dropdowns are missing one of the two highest-volume channels for this account; every FB sale currently files under `manual`, corrupting per-platform reporting. One-line fix, ship immediately.
- [ ] **Fast cash-sale entry** — FB local-cash sales generate no 1099-K, so recording them promptly is the only completeness control; needs a sub-10-second entry path (item + price, platform/date/quantity defaulted) instead of the full multi-field modal.
- [ ] **REQ-08 — Multi-item order entry** — `record_sale` takes one `item_id` per call; bundle sales ("$100 for the whole pile," multi-line eBay/TCGPlayer orders) require hand-split prices/fees today with nothing enforcing the split reconciles to what was actually received.

### Settlement Reconciliation

_Full design in [`docs/superpowers/specs/2026-07-10-settlement-reconciliation-design.md`](docs/superpowers/specs/2026-07-10-settlement-reconciliation-design.md) — builds on the Settlement Status view item below rather than replacing it._

- [ ] **REQ-09 — Settlement/disbursement reconciliation model** — deposit-as-clearing-account: itemized sale components (already in `transactions` via `related_sale_id`/`parent_settlement_id`) are Schedule C truth; the bank deposit is a reconciliation check-figure (linked components must sum to it), never income itself. Companion spec adds `settlement_platform_charges` (ad spend/subscriptions/label fees withheld from payouts, currently untracked entirely) and a manual-linking UI that works before CSV import ships.

### Export
- [ ] **CSV export** — per-period Schedule C transaction export (browser download instead of mobile's share sheet); strip Non-Business rows (`isExcluded` categories), fix amount sign convention (export `abs()` + `Type` column), add `Platform` + `Gross Amount` columns
- [ ] **Schedule C Summary export** — one row per IRS line with net profit at bottom (the "form", not a transaction dump) — same gap exists on mobile, worth shipping here first

### Settings / Misc
- [ ] **Marketplace OAuth connections** (eBay/Amazon) — port of `MarketplaceAccountsView`; web flow uses a standard OAuth redirect instead of `ASWebAuthenticationSession`
- [ ] **Merchant auto-categorization rules** — `category_rules` table (mobile backlog item, not yet built on either client); ship on web first since the UI is simpler as a settings table

---

## 🟠 P2 — Tax Compliance & Filing

_Same priority tier as mobile's P2 — port once the core workflow above is solid._

- [ ] **Inventory valuation (Beginning/Ending) stored in Supabase, not browser storage** — create `inventory_valuations` table (`user_id`, `tax_year`, `beginning_inventory`, `ending_inventory`) instead of repeating mobile's `UserDefaults`-only mistake (flagged as a systemic risk in mobile's audit); Part III card reads/writes here. **Elevated by the 2026-07-10 compliance review** — this account holds sealed product across year-end as a deliberate strategy, not an accident, so ending inventory will be material every year; treat as near-P1, not background P2.
- [ ] **Year-end inventory snapshot button** — "Use Current Inventory Value" pre-fill from `sum(quantity_remaining × unit_cost)`
- [ ] **Self-employment tax estimate** — SE tax widget (15.3% on net profit up to SS wage base) on Dashboard
- [ ] **1099-K reconciliation view** — enter 1099-K amounts per platform, compare to Part I breakdown by platform. **Elevated by the 2026-07-10 compliance review** — 4 sale channels, 3 of which issue 1099-Ks at this account's volume; depends on REQ-03 (Returns & Allowances split) and REQ-07 (Facebook in the platform list) landing first.
- [ ] **Settlements warning on export** — block/warn CSV export if unbroken settlements exist in the period
- [ ] **COGS unlinked flag** — surface `cost_of_goods` transactions with no linked lot
- [ ] **Cash basis disclosure** — "Accounting Method: Cash Basis" note in a Tax Settings page and export header
- [ ] **Receipt coverage warning** — flag COGS transactions over a threshold with no receipt
- [ ] **Quarterly estimated tax calendar** — payment dates + estimated amounts based on YTD net profit

### 🔎 New P2 items — 2026-07-10 compliance review

_Hardening items from the same audit — see [`docs/superpowers/specs/2026-07-10-compliance-review-findings.md`](docs/superpowers/specs/2026-07-10-compliance-review-findings.md) for full detail on each (F-04–F-08)._

- [ ] **REQ-16 — Custom-category integrity guard** — `custom_categories.parent_value` has no DB-level check against the built-in category list; a broken mapping (rename drift, or divergence from iOS's independently-ported `categories.ts`) causes a transaction to still count toward the Total Expenses KPI while vanishing from the itemized Schedule C breakdown — the two totals silently stop tying out. Add a DB allowlist check, and render an explicit "Unmapped category" line for any total that can't be resolved.
- [ ] **REQ-15 — Soft-delete `transactions` + edit/delete history** — `transactions` is the one core table without `deleted_at`; edits to amount/date/category overwrite in place with no trail. Add `deleted_at` (matching every other table) and a lightweight history table capturing prior `amount`/`date`/`schedule_c_category`.
- [ ] **REQ-18 — Period lock for filed tax years** — nothing prevents editing a record dated in an already-filed year; pairs naturally with the `tax_profiles` table above (a "lock entries before this date" setting).
- [ ] **REQ-19 — Cents-rounding discipline at aggregation boundaries** — `scheduleCMath.ts`/`computeProfitability` sum native JS floats with no rounding step; two totals derived from the same rows can in principle differ by a sub-cent amount that display rounding turns into a visible 1¢ mismatch. Round to cents at each aggregation boundary.
- [ ] **REQ-20 — Gate "final" output on data completeness** — extend the existing "Settlements warning on export" idea to cover uncategorized transactions and oversold sales too (today only uncategorized has even a soft dashboard banner; oversold has none). Require zero uncategorized/oversold in the export period, or an explicit "export anyway, N excluded" acknowledgement.

---

## 🟡 P3 — UX & Dashboard Polish

- [ ] **Inventory value at cost card** on Dashboard
- [ ] **Top selling items card** on Dashboard
- [ ] **Per-platform sales breakdown card** on Dashboard + filter in Sales table
- [ ] **Plaid webhooks** — `TRANSACTIONS` webhook instead of relying solely on manual/cron sync; web has no "background app refresh" excuse mobile has, so this matters more here
- [ ] **Duplicate + anomaly detection** — flag same amount + merchant within 3 days
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

- [ ] `inventory_lots` needs a `purchase_date` column (currently only has `created_at`) — blocks correct FIFO ordering for back-dated lot entries
- [ ] No inventory adjustment type for personal-use withdrawal / shrinkage (Schedule C Line 36 requires excluding these from COGS) — elevated to REQ-06 under P1 "Collectibles Workflows" above per the 2026-07-10 compliance review; see [`2026-07-10-compliance-review-findings.md`](docs/superpowers/specs/2026-07-10-compliance-review-findings.md) finding O-01
- [ ] No `quantity` column on `transactions` — root cause of CSV multi-unit sales hardcoding `quantity: 1`
- [ ] No `tax_profiles` table — Schedule C header fields, home office sqft, vehicle method scattered or missing entirely; prerequisite for multi-device + accountant export features
- [ ] No `sales_tax` column on `sales`/`transactions` — can't prove Line 1 excludes pass-through sales tax
- [ ] Verify RLS on `marketplace_connections.access_token`/`refresh_token` is service-role-only (security check, not yet confirmed on either client)
- [ ] Edge functions (`record_sale`, `record_return`, `import_marketplace_csv`, Plaid functions) are not in either repo — unversioned, unreviewable. Set up `supabase link` and commit `supabase/functions/` to this repo (or a shared backend repo if mobile is retired)
- [ ] No automated tests for Schedule C math on either client — add test coverage here as features are ported, rather than carrying the gap forward
