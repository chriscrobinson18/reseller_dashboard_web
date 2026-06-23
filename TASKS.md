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

- [ ] **`scheduleCTotals` sign handling** — `computeScheduleC` in `DashboardPage.tsx` currently does `Math.abs(t.amount) * mult` per category; verify refunds/credits in expense categories *reduce* the category total rather than adding to it. Sum signed amounts per category, `abs()` only at display time for expense lines.
- [ ] **Part III scope mismatch** — `computeProfitability`/COGS is period-scoped but any future "Beginning/Ending Inventory" feature (see P2) must use full-tax-year values regardless of selected period, or the formula is IRS-incorrect. Design this correctly from the start — don't add a period-scoped Part III card.
- [ ] **Custom categories must appear in Schedule C breakdown from day one** — when custom categories ship (see P1), `computeScheduleC` must include them, not just `CATEGORIES.find(...)` built-ins.
- [ ] **Returns vs. Line 1 netting** — when `record_return` / refund handling ships (see P1), split negative payout rows into a "Returns & Allowances" bucket in the Schedule C breakdown rather than silently netting into Part I gross revenue (1099-K mismatch risk).
- [ ] **`record_return`: fix cost basis + create refund transaction row** — same edge-function bugs as mobile (uses `salePrice` instead of lot `unit_cost` for cost restoration; no `transactions` row inserted for the refund). Fix in the shared edge function — benefits both clients.
- [ ] **`record_sale`: accept and store fees/shipping_cost** — confirm the edge function actually persists `fees`/`shipping_cost` params (mobile found these were silently dropped). `RecordSaleModal`/`EditSaleModal` pass them — verify end-to-end.
- [ ] **`Sale.profit` partial return fix** — `SalesPage.tsx` `SaleDetail` already subtracts `refunded_amount` for partial returns (looks correct) — confirm this matches the edge function's `return_status` semantics and add a regression test once a test setup exists.
- [ ] **Deleting a sale doesn't reverse FIFO depletion** — `deleteSale` mutation (see `src/lib/mutations.ts`) needs to restore `quantity_remaining` on depleted lots and remove `inventory_movements` rows before soft-deleting, or stock counts are permanently understated. Same bug as mobile.

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
- [ ] **Settlement Status view** — port of mobile's `SettlementStatusView`/`SettlementDetailView`: segmented platform picker, Needs Breakdown / Breakdown Imported sections, disbursement matching UI
- [ ] **CSV → Sales auto-sync** — verify `syncCSVOrdersToSales` (already runs server-side per mobile's notes) surfaces correctly in the web Sales table once CSV import ships

### Categorization
- [ ] **Custom Schedule C categories** — `CustomCategoryStore` is UserDefaults-only on mobile (device-local); for web, store in a Supabase table instead (`custom_categories`: `user_id`, `name`, `icon`, `color`) so it's usable cross-device — this is a web-native improvement over the mobile implementation, not just a port
- [ ] **Bulk categorize** — multi-select rows in Expenses table + assign category to all selected at once (mobile has this via swipe; web should use checkbox column)
- [ ] **Quick categorize from list** — inline category change without opening detail panel (web's `CategoryDropdown` already supports this from the table — confirm UX is on par)
- [ ] **Period chip filter + sort** in Expenses — mobile has Date/Amount/Merchant sort with asc/desc toggle and a richer period preset/account filter sheet; web only has the basic period picker + search + single category filter today

### Receipts
- [ ] **Receipt attachment** — file upload to the existing private `receipts` Supabase Storage bucket (already created for mobile, RLS user-scoped); inline preview + replace + delete in the transaction detail slide-over

### Returns
- [ ] **Return/refund UI** — "Process Return" button in Sale detail calling `record_return` edge function (UI doesn't exist on either client yet for return entry — ship web-first since mobile's is also a TODO)

### Export
- [ ] **CSV export** — per-period Schedule C transaction export (browser download instead of mobile's share sheet); strip Non-Business rows (`isExcluded` categories), fix amount sign convention (export `abs()` + `Type` column), add `Platform` + `Gross Amount` columns
- [ ] **Schedule C Summary export** — one row per IRS line with net profit at bottom (the "form", not a transaction dump) — same gap exists on mobile, worth shipping here first

### Settings / Misc
- [ ] **Marketplace OAuth connections** (eBay/Amazon) — port of `MarketplaceAccountsView`; web flow uses a standard OAuth redirect instead of `ASWebAuthenticationSession`
- [ ] **Merchant auto-categorization rules** — `category_rules` table (mobile backlog item, not yet built on either client); ship on web first since the UI is simpler as a settings table

---

## 🟠 P2 — Tax Compliance & Filing

_Same priority tier as mobile's P2 — port once the core workflow above is solid._

- [ ] **Inventory valuation (Beginning/Ending) stored in Supabase, not browser storage** — create `inventory_valuations` table (`user_id`, `tax_year`, `beginning_inventory`, `ending_inventory`) instead of repeating mobile's `UserDefaults`-only mistake (flagged as a systemic risk in mobile's audit); Part III card reads/writes here
- [ ] **Year-end inventory snapshot button** — "Use Current Inventory Value" pre-fill from `sum(quantity_remaining × unit_cost)`
- [ ] **Self-employment tax estimate** — SE tax widget (15.3% on net profit up to SS wage base) on Dashboard
- [ ] **1099-K reconciliation view** — enter 1099-K amounts per platform, compare to Part I breakdown by platform
- [ ] **Settlements warning on export** — block/warn CSV export if unbroken settlements exist in the period
- [ ] **COGS unlinked flag** — surface `cost_of_goods` transactions with no linked lot
- [ ] **Cash basis disclosure** — "Accounting Method: Cash Basis" note in a Tax Settings page and export header
- [ ] **Receipt coverage warning** — flag COGS transactions over a threshold with no receipt
- [ ] **Quarterly estimated tax calendar** — payment dates + estimated amounts based on YTD net profit

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

## 🗄️ Schema/Architecture Notes Inherited from Mobile

_Carried over from mobile's "June 2026 Architectural Review" since both clients share the schema — fix once, both clients benefit:_

- [ ] `inventory_lots` needs a `purchase_date` column (currently only has `created_at`) — blocks correct FIFO ordering for back-dated lot entries
- [ ] No inventory adjustment type for personal-use withdrawal / shrinkage (Schedule C Line 36 requires excluding these from COGS)
- [ ] No `quantity` column on `transactions` — root cause of CSV multi-unit sales hardcoding `quantity: 1`
- [ ] No `tax_profiles` table — Schedule C header fields, home office sqft, vehicle method scattered or missing entirely; prerequisite for multi-device + accountant export features
- [ ] No `sales_tax` column on `sales`/`transactions` — can't prove Line 1 excludes pass-through sales tax
- [ ] Verify RLS on `marketplace_connections.access_token`/`refresh_token` is service-role-only (security check, not yet confirmed on either client)
- [ ] Edge functions (`record_sale`, `record_return`, `import_marketplace_csv`, Plaid functions) are not in either repo — unversioned, unreviewable. Set up `supabase link` and commit `supabase/functions/` to this repo (or a shared backend repo if mobile is retired)
- [ ] No automated tests for Schedule C math on either client — add test coverage here as features are ported, rather than carrying the gap forward
