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
- [x] **Breakdown Inventory (box opening) flow** (2026-08-03) — the other half of [that spec](docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md): breaks an existing inventory lot (sealed box, bundle) into many single-card lots with basis allocated by relative FMV / equal / specific $ (`box_openings` table, `openBox`/`deleteBoxOpening`, `OpenBoxModal`, `BoxOpeningDetailSlideOver` — UI says "Breakdown Inventory"; table/function names unchanged). Revised same-day to pick the box from inventory (depleting its lot) instead of typing a name/cost and posting a new transaction — the box's cost is already deducted at purchase, so a second deduction at open time would double-count it. See [`docs/features/inventory.md`](docs/features/inventory.md#opening-a-box). _`box_openings` table, `source_lot_id`/`quantity` columns, and shortcut relaxation all confirmed live in production (2026-08-25 audit). Note: `20260803120000` and `20260803130000` were applied directly and are not tracked in `schema_migrations` — `supabase db push` will fail on them; apply any future box_openings migrations manually or repair the migration history first._

### Categories
- All 21 Schedule C categories ported from mobile (`src/lib/categories.ts`), including `meals` 50% multiplier flag and `isExcluded` flag for transfer/personal/settlement/balance_adjustment

---

## 🧹 Books Cleanup — 2025 amended return + 2026 filing

> **New session? Start with [`docs/books-cleanup-handoff.md`](docs/books-cleanup-handoff.md)** (working rules, decisions, live vs. branch state, next step).

_Started 2026-11-09. Scope: Schedule C accuracy for tax years 2025 (amendment) and 2026 (filing); 2024 is out of scope. Per-item sale ↔ inventory linking is **not** required for past years. This repo is public, so no amounts, merchant names or account numbers go here; data snapshots and undo backups are kept privately, never in git._

**Accounting model (decided):**
- Income comes from **recorded sales** (marketplace imports, Record Sale, Apple Shortcut). Bank deposits never carry income: each one is tagged `settlement` (sales proceeds arriving), `transfer` (own money) or `personal`.
- Income is earned when the buyer pays, not when the money is deposited. Personal spending of business money before it's deposited is an owner's draw: not deductible, and it doesn't reduce income.
- Going forward (option C): **deposit all business money first, then pay yourself from the bank.** Venmo is personal-only. Bank accounts in the app are business-only.
- Rule for converting history: **record the sales first, then re-tag their deposits as settlements.** Never the reverse, or the income disappears.

**Done (2026-11-09):**
- [x] Legacy iOS category tags (`proxies`, `automation_software`, `cook_group`, `memberships`, `equipment`, `disbursement`) re-tagged onto real Schedule C lines; custom category "Software & Subscriptions" (Line 27a)
- [x] Credit-card payments (`LOAN_PAYMENTS`) → `transfer`: backfilled, plus a sync rule
- [x] PayPal / Cash App wallet cash-outs → `settlement` (sync rule + existing rows); Venmo kept as `transfer`
- [x] Custom category **"Memberships"** (Line 27a): warehouse-club and retailer memberships used for inventory buying, split out of "Software & Subscriptions" and cost of goods. Membership **refunds** use the same category so they net against the fee. Merchants that sell both goods and memberships under one merchant ID get no category rule.
- [x] Custom category **"Credit Card Rewards"** (Line 27a): card cash-back earned on spending. Treated as a reduction of expenses, not income and not excluded, because the purchases that earned it were deducted. Same net-profit effect as reporting it as other income, without mixing it into gross receipts.
- [x] Marketplace audit (Phase 1): card-side refunds of marketplace purchases that were tagged as income, or left over from the P0 settlement bug, re-tagged to cost of goods. Marketplace payouts into checking that were tagged `transfer` re-tagged to `settlement` (label only). Payouts into checking still tagged as income are left for Phase 2, until the matching sales CSVs are confirmed.
- [x] Custom category **"Tech & Dev Tools"** (Line 27a): AI assistants, cloud hosting, bank-data API fees and design tools used to build and run the business's own software (this app). Deliberately **not** named "R&D": research-expense rules (§174 / §174A) are a separate tax regime, and these are ordinary subscription costs. Split out of "Software & Subscriptions", which keeps sourcing bots, proxies and cook groups.
- [x] Personal cards removed: sync disabled per account, their transactions deleted (full backup kept privately)

**Decided 2026-11-09 (owner):**
- **Income is computed from the Sales tab** (`sales` rows: gross on Line 1, refunds on Line 2, fees on Line 10, platform-deducted shipping as an expense), not from bank deposits or CSV payout rows. Settlement deposits are **insurance**: the year-end tie-out compares them to recorded sales to prove every sale is recorded.
- **Inventory method: traditional (§471)**, i.e. Part III = beginning inventory + purchases − ending inventory, with year-end inventory values per tax year. This resolves the P2 method blocker below.

**Phases:**
- [x] **Phase 1: Categorize spending.** _Done 2026-11-09._ Every 2025–26 transaction on business accounts has a category; batched by merchant group with owner approval per batch, undo backups kept privately. Category rules created for repeat merchants that have a merchant ID and a single category (mixed merchants, which sell both goods and memberships or supplies, get none). Card refunds the sync had mislabeled as settlements, or marketplace refunds tagged as income, were re-tagged to net against the purchase category. Same date + amount + merchant rows kept as genuine repeat charges. New custom categories: Memberships, Credit Card Rewards, Tech & Dev Tools. One known gap: marketplace deposits whose sales aren't recorded yet (see the policy and import items below, and Phase 3).
- [ ] **Phase 3 carry-over:** one non-marketplace sale (a grading-company sale, October 2025) has its deposit tagged `settlement` with no sale recorded; record it with the retroactive sales load.
- [ ] **2025 TCGplayer payouts not in the books (noted 2026-11-10):** 2025 TCGplayer sales are recorded (Sep 27 – Dec 30), but no 2025 TCGplayer deposit exists in any linked account. TCGplayer first paid ••7382 on 2026-01-27 (two bank-verification test deposits), and ••7382 has no history before 2026-01-26. A TCGplayer payout email from Oct 2025 says "Chase Checking", but it appears in neither ••4979 nor ••7382. **Owner: the closed Chase account ••1722 likely received the 2025 TCGplayer payouts.** Its statements aren't online; request Sep 2025 – Jan 2026 from Chase (secure message, phone or branch). When they arrive: add the TCGplayer payouts as `settlement` deposits (owner approval first), and check that account for **business expenses missing from Schedule C**. Income is unaffected (it comes from the recorded sales). Cross-check: 2025 TCGplayer 1099-K gross vs recorded 2025 TCGplayer gross. **Update 2026-11-12 (Gmail, read-only):** TCGplayer's payout emails show 19 completed 2025 transfers (Oct 8 – Dec 31) to "Chase Checking", i.e. the closed ••1722. Their total is within tie-out tolerance of recorded 2025 TCGplayer sales net (the gap is late-December timing plus the unimported TCGplayer refunds). So the 2025 TCGplayer sales look complete. **Owner decision: don't insert the payouts from the emails; the owner will send the ••1722 statements and they'll be added from those.** Also in the emails: a Jan 2026 transfer to Chase Checking was cancelled (account closed), and from Feb 2026 payouts go to "Chase Business Checking" (••7382).
- [ ] **Phase 2: Classify incoming money.** Uncategorized credits, plus deposits currently tagged `payout` (P2P, Zelle, cash): label each as settlement / transfer / refund / owner contribution, following the conversion rule above.
- [ ] **Phase 3: Missing sales.** P2P, cash, Whatnot/Facebook and other non-imported sales for 2025–26, from wallet statements and records. One-off data loads through the same code path as Record Sale (not new import features); one summary sale per month where line-item detail is gone. Then re-tag the matching deposits as `settlement`.
- [ ] **Phase 4: Missing transactions.** Business expenses that never reached the bank (cash spent at shows, purchases from wallet balances), entered by hand.
- [ ] **Phase 5: Inventory (Part III).** Year-end inventory value as of 2025-12-31 and 2026-12-31 (count or estimate).
- [ ] **Phase 6: Close each year.** Schedule C totals per line for 2025 and 2026, compared with the filed 2025 return → hand to tax preparer for the 1040-X decision.

**Code follow-ups found during cleanup:**
- [x] **Deployed `plaid_sync_transactions` v46** (2026-11-09): card-payment rule + wallet settlement rule, rebuilt on top of the *live* v35 source (the repo copy was missing v35's `category_rules` sync step, so a deploy from the repo would have silently removed it). Byte-identical to the repo after deploy; JWT verification kept on.
- [x] **Pinned `npm:plaid@47.0.0`** in all 4 Plaid functions (was `@latest`). plaid@51 (2026-11-06) removed `Configuration` / `PlaidApi` / `PlaidEnvironments`, so **any** redeploy on `@latest` fails at load and breaks bank sync. Versions 47, 48 and 50 type-check clean.
- [x] **Repo vs production audit (2026-11-09):** all 13 functions in this repo match production code. The only drift was `plaid_sync_transactions` (fixed above); `find_plaid_orphans` differed only in header comments (now synced). Production has 11 more functions that aren't in this repo (eBay OAuth, `plaid_sync_scheduled`, `plaid_create_link_token`, backfills, etc.), presumably managed from the iOS repo.
- [ ] **Always download live source and diff before deploying any edge function** (`supabase functions download <name>`). Production-only functions that import `npm:plaid@latest` (e.g. `plaid_create_link_token`, `plaid_backfill_*`) will break the same way on their next deploy: pin them wherever they're maintained.
- [x] **P0: `classifySettlement` tagged *any* incoming "eBay" credit as a settlement**, including refunds on credit cards. _Fixed and **deployed 2026-11-09** (`plaid_sync_transactions` v47, `plaid_sync_scheduled` v27): the Plaid account `type` + `subtype` from the `transactionsSync` accounts list is passed into `buildRow`, and only credits on `depository` checking / savings / money-market / cash-management accounts can be settlements. Card credits fall through to category rules and the PFC map. Unknown accounts fail closed. Live source was downloaded and diffed before deploying, and re-downloaded after (byte-identical to the repo); JWT verification unchanged. Rows already mis-tagged are cleaned up in Phase 1._
- [x] **P0: the daily cron sync ran a stale fork of the sync logic.** `plaid_sync_scheduled` (production-only until now, v16, "matches plaid_sync_transactions v27") inserted rows with no `plaid_account_id`, no `merchant_entity_id` or other v32 metadata, and skipped `category_rules`, the card-payment / wallet-settlement rules, the pending→posted handoff and `plaid_items.status` error reporting. Both functions share `plaid_items.cursor`, so most new rows came through this path and category rules couldn't match them. _Fixed and deployed 2026-11-09: per-item logic moved to `supabase/functions/_shared/plaidSync.ts`; both functions call the same `syncPlaidItem` (live v16 source committed first for a reviewable diff). plaid pinned to 47.0.0. After any change to the shared file, redeploy **both**._
- [x] **Applied `20261109120000_plaid_sync_cron_async.sql` (2026-11-09).** The cron job's synchronous HTTP call timed out after 5 s, so every daily run since April was logged as "failed" while the function actually completed. The old job was replaced by `plaid-sync-scheduled-daily` (same 08:00 UTC schedule, async `net.http_post`, 5-minute timeout), so real failures are now visible.
- [x] **Removed the obsolete `sync-ebay-daily` pg_cron job (2026-11-09, migration `20261109130000_drop_ebay_api_cron.sql`).** eBay moved from the API back to CSV upload; the job had failed daily since 2026-09-03 (`ebay_tokens` table gone). Only `plaid-sync-scheduled-daily` remains. Phase 3 must check eBay CSV coverage month by month, since there is no API backfill.
- [x] **Full resync of all Plaid items (2026-11-09)** through the new shared sync path: 0 duplicate transaction IDs, all items active, merchant IDs backfilled where Plaid provides them. Settlements on re-delivered history landed only on checking accounts (P0 fix confirmed on live data). Still to confirm: one manual **Sync Now** from Settings (the on-demand function hasn't been run live since deploy).
- [ ] **Backfill rows the old cron inserted** (no `merchant_entity_id` / `plaid_account_id`): Force Full Resync on each item runs the metadata refresh pass, which fills `merchant_entity_id` and the other v32 columns so category rules can match. `plaid_account_id` isn't part of that pass; backfill it from `account_display` + `plaid_accounts.mask` if needed.
- [x] **P0: Dashboard "Total Income" leaves out sale-linked and CSV-import income** (it counts only deposits tagged `payout`). Under the sales-based model it will trend toward $0 even though the Schedule C export is correct. Make the card match the export. _Resolved by sales-based income step 2 (`computeKPIs` adds sales gross − returns; `bucketTransaction` drops sale-derived and settlement rows). Regression test 2026-11-09: KPI income = Schedule C Line 1 − Line 2._
- [x] **Policy (2026-11-09): marketplace deposits are always `settlement`.** Deposits from the marketplaces whose sales are imported (eBay, Amazon, TCGplayer) are never tagged as income; income comes only from recorded sales. All 2025–26 such deposits re-tagged. Consequence: income for any month whose sales aren't imported yet is **missing** until the import happens. Non-sale payouts (inventory-loss reimbursements, label/claim credits, buylist payouts not in the order import) show up as differences in the year-end tie-out and are handled there.
- [x] **Import the missing marketplace months for 2026** _(done 2026-11-10 by the owner: TCGplayer through early November, Amazon 2025–26, eBay Order Earnings + Transaction Report through early November; all verified read-only, no duplicates or deletions)._ Re-import again before closing 2026 to pick up November–December.
- [ ] **Amazon purchase review (tabled):** split Amazon card charges into subscriptions / supplies / cost of goods using the Amazon order-history export, matched to bank charges by date + amount.
- [x] **Sales-based income, step 1 (2026-11-09):** `sales.shipping_charged` migration applied (TCGplayer buyer-paid shipping moved out of `shipping_cost`); marketplace order re-imports backfill instead of clobbering (`_shared/salesImport.ts`; `import_marketplace_csv` v28, `import_tcgplayer_orders` v3 deployed and verified against the repo).
- [x] **Sales-based income, step 2 (2026-11-09, code on branch, not yet merged):** Schedule C income from `sales` (Line 1 = price + `shipping_charged`, Line 2 = refunds, Line 10 = fees incl. promoted-listing fees, platform labels = `shipping_cost`); drop CSV payout/fee/shipping rows and sale-linked transactions from the Schedule C math. Shared lib + tests, Dashboard + both CSV exports.
- [x] **Data cleanup found by step 2 (2026-11-09):** trade income legs double-counted with the trade's given-side sales: fixed in code (`isSaleDerivedTransaction` now treats positive `trade_id` rows as sale-derived; COGS legs still count, so a pure swap nets to zero). Card refunds tagged `payout` → cost of goods; one marketplace's real-time transfers still tagged `payout` → `settlement`; a prediction-market return of a personal deposit → personal; a withdrawal from a pre-business personal investment → `transfer` (owner funds). Net-zero-paired rows left untouched.
- [x] **Owner decision 2026-11-10: no bank deposit is income.** All 27 remaining 2025–26 `payout` deposits were re-tagged (backup kept privately, guarded update, re-verified): auction-house payout, Zelle, PayPal, Venmo and Cash App → `settlement` with a `platform` label (`goldin`, `zelle`, `paypal`, `venmo`, `cashapp`) so each shows as its own row in the Tie-Out card; the distributor payments (owner's money moved from another bank) → `transfer`. **This reverses the earlier "keep `payout` until sales are recorded" rule:** Schedule C income is now understated until their sales are entered in the Sales tab (Phase 3). The Tie-Out card is the worklist. Nothing gets filed before Phase 3 is done. Rare non-sale business income (platform bonuses, etc.) may still be tagged `payout` deliberately.
- [ ] **Step 3: Part III, traditional method** — code live 2026-11-09 (merged to `main`); migration `20261109150000_inventory_valuations.sql` applied. Then enter year-end values: 2024 ending (from the filed return), 2025 ending, 2026 ending.
- [x] **Make `sync_csv_orders_to_sales` (Amazon) re-import safe** _(2026-11-09, v5)_: writes now go through `_shared/salesImport.ts` (never un-deletes, never resets inventory / return fields, never auto-deletes orphans; reports them instead). Live source was byte-identical to the repo before the change; Amazon sales backed up privately before deploy.
- [x] **Amazon postage credits counted as costs (fixed and deployed 2026-11-10, sync v6 = deploy version 10, JWT on, byte-identical to repo):** `shipping_postage` rows were summed with `Math.abs`, so a postage refund raised `shipping_cost` (overstating Line 27a and understating net). Now summed signed, like fees, with the per-order math in `_shared/csvOrderAggregate.ts` and unit tests. After deploy, re-run the Amazon import to correct existing sales.
- [ ] **Amazon refunds are netted into Line 1:** the sync stores `sale_price` = gross − refunds and leaves `refunded_amount` empty, so Amazon refunds never reach Line 2 (1099-K mismatch risk, same issue as the P0 "Returns vs. Line 1 netting" item). Fix: store gross in `sale_price` and refunds in `refunded_amount`, as eBay does (money-math change; review the 2025 numbers first).
- [ ] **TCGplayer refund amounts:** the order import ignores `refunds[]`, so refunded TCGplayer orders have `return_status` but no `refunded_amount`.

**Inventory lots from order emails (2026-11-12, owner-approved; backups kept privately):**
- [x] **57 charge/refund pairs → net-zero** (2025: 38, 2026: 19): same merchant, same amount, refund within 90 days of the charge. Cross-year pairs that reach into 2024 were left out (a 2025 refund of a 2024 purchase correctly reduces 2025 cost of goods). Partial refunds (no same-amount charge) stay as separate refunds.
- [x] **2026 cost-of-goods charges → inventory lots:** each unlinked charge was matched to its order email by **merchant + exact amount** (Gmail, read-only, via helper agents; every match re-checked for the same merchant). One lot per distinct item. Lot costs sum **exactly** to the charge, split across items by their price ratio (tax, shipping and FX included proportionally), then penny-split per unit as `splitLotCost` does. All units stay on hand until a sale is linked. Verified after insert: every charge's lot links and lot costs equal the charge to the cent.
  - Skipped (left for manual entry): charges with no order email, orders whose email doesn't show every item (most Walmart emails), several candidate orders, totals that don't match, partial shipments. Cancelled orders were handled by the net-zero pairs instead.
  - Topps Vault multi-order drops: only the **delivered** orders got lots; the cancelled orders were never charged or were refunded.
  - Bad World (GBP orders): the USD charge is allocated by the GBP price ratio, since FX makes a to-the-cent match impossible.
- [ ] **2025 cost-of-goods charges → lots:** same process, next.
- [ ] **2 orphaned cost-of-goods half-pairs:** a GameStop charge (Aug 2025) and a Wizards of the Coast charge (Jan 2026) carry a `net_zero_pair_id` whose partner row no longer exists, so they're silently excluded from cost of goods. Check each: if it was a real purchase, use **Unpair** (Expenses detail panel) so it counts again. 22 other orphaned half-pairs are `transfer` rows (no Schedule C effect); tidy them with Unpair when convenient.

**Open data issues — health check 2026-11-10 (read-only; owner approval before any write):**
- [x] **Re-export CSVs made before the row-cap fix** _(closed 2026-11-10: the owner had made no exports, so nothing to replace)._ Any Summary / Transactions CSV for a period over 1000 transactions (e.g. a full year) exported before 2026-11-10 understated expenses; re-export anything already given to a preparer.
- [ ] **Check the Tie-Out card layout** on a phone (no sideways scroll at 320–430px) and on desktop. It wasn't checked visually because the session can't sign in.
- [ ] **Tie-out flags to resolve:**
  - **PayPal / Cash App cash-outs** tagged `settlement` with no recorded sales: income is missing until their sales are recorded (Phase 3).
  - **Amazon 2025:** deposits exceed sales; this looks like January payouts of December 2024 sales. Note it for the preparer (2024 is out of scope).
  - **Amazon 2026:** sales exceed deposits, just over tolerance; re-check after the next payouts.
- [ ] **Tie-out can't match manual sales to wallet / P2P deposits:** manual sales have platform `manual` and no deposit platform. Enhancement: map `sales.payment_method` (Venmo / Cash App / PayPal / Zelle / cash) to a deposit platform in `computeTieOut`, so recorded P2P sales offset wallet deposits.
- [x] **Same-day identical charges** _(closed 2026-11-10, owner decision)_: all 125 groups (373 rows) on the same account with the same date, amount and merchant are treated as **genuine repeat purchases** (each has its own Plaid transaction ID), per the standing rule. Nothing is deleted.
- [x] **3 suspected old-cron / new-sync duplicates (April 2026)** _(closed 2026-11-10: not duplicates)_. Each pair is on **different accounts** (checking vs card, or two different cards), so they're separate purchases on the same day. They were only flagged because old-cron rows have no `plaid_account_id`. Nothing deleted.
- [ ] **Duplicate `plaid_accounts` rows:** 11 account masks are listed 2–3 times (leftovers from reconnects; one has a bullet in `display_name`, one doesn't). Cosmetic. Consolidate after the `plaid_account_id` backfill above, with a backup.
- [ ] **eBay 2025 Transaction Report gaps:** 27 orders in Order Earnings have no Transaction Report rows, clustered in May, July and November 2025. Re-download those months' Transaction Reports. This is audit only; income uses Order Earnings.
- [ ] **6 manual sales (2026) have no stored `net_payout`:** the math falls back to price − fees − shipping. Backfill the stored value (data write).
- [ ] **Sales page linked-transaction lookup sends every sale ID in one URL** (`.in('related_sale_id', saleIds)`): long periods risk URL-length errors. Chunk the ID list.
- [ ] **Security check: TCGplayer paid out to an unknown "Mercury Checking" account in Jan 2026** (one small transfer, created Jan 12 and completed Jan 14, per TCGplayer email). **The owner has no Mercury account.** Check TCGplayer payment settings / history for who changed the payout bank, secure the account (password, 2FA), and report it to TCGplayer support if it wasn't the owner. Payouts went back to ••7382 by Feb 2026.
- [ ] **Closed Chase ••1722 is in `plaid_accounts` with zero transactions:** Plaid returns nothing for closed accounts, so its history must come from statements (see the 2025 TCGplayer payouts item).
- [x] **Step 4: Year-End Tie-Out (built 2026-11-10, on the branch):** `TieOutCard` on the Dashboard: platform table (sales net vs settlement deposits, month drill-down, flags), deposits still counted as income, and the eBay Order Earnings vs Transaction Report check. Lib `tieOut.ts` + `tieOutData.ts`, unit-tested; the card's queries were run read-only against production and matched an independent SQL tie-out to the cent. See `docs/features/dashboard.md`.
- [x] **P0: 1000-row cap silently truncated year views (found and fixed 2026-11-10, on the branch):** PostgREST `max_rows` = 1000, so `.limit(5000)` returned 1000 rows. The Dashboard (KPIs, Schedule C, both CSV exports), Part III purchases, Expenses and Sales showed only the most recent 1000 rows of a period: a full-2025 view started mid-July, and 2026 YTD started late May. Fixed with `src/lib/fetchAll.ts` (`fetchAllRows`, stable `id` order, tests) on every year-scale list fetch; verified on production data that every 2025 / 2026 transaction is returned with no duplicates. **Any Summary / Transactions CSV exported before this fix for a period over 1000 rows is wrong: re-export.**

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

- [x] **Duplicate transactions in the live dataset — overstates BOTH income and COGS** — _Closed 2026-09-23._ Three-step plan fully complete:
  - **Cleaned:** July 25 AmEx reconnect re-imports (bare nulls with older copies), July 22 ••6883 Chase reconnect re-imports (same criteria), 10 ••4979 AmEx bill-payment dupes. ~500+ rows removed total (2026-08-25).
  - **Step 1 — Prevention shipped (2026-08-25):** `plaid_exchange_token` v17 detects duplicate connections by `account_id` before exchanging a public token. See `docs/superpowers/specs/2026-08-25-plaid-dedup-design.md`.
  - **Step 2 — Re-sync affected cards:** completed via Force Full Resync on ••1000, ••1004, ••2003.
  - **Step 3 — Orphan scan shipped (2026-09-23):** `find_plaid_orphans` edge function compares DB rows against Plaid's canonical `/transactions/get` response; 554 orphaned rows from old/revoked Plaid connections deleted via Settings → Banks → Find Duplicates. See `docs/superpowers/specs/2026-09-23-dedupe-review-ui-design.md`.
- [x] **22 uncategorized AmEx bill payments — latent double-deduction** — _Closed 2026-08-25._ Found 33 null rows total (more than the original 22 count). 10 were exact Plaid re-import duplicates on ••4979 (null copy deleted, transfer copy kept). 23 on ••7382 were genuine uncategorized bill payments → bulk-set to `transfer`. Two ••7382 pairs (2026-03-09: -$1,685.37 and -$383.97) remain as duplicate transfer rows — no tax impact (both excluded), flag for duplicate cleanup pass.
- [x] **`record_sale`/`reverse_return` need redeploying — deleted lots stayed FIFO-eligible (found 2026-08-02)** — _Deployed 2026-08-25._ Both functions now filter `deleted_at is null` in FIFO lot query.

---

## 🔴 P1 — Core Feature Parity with Mobile

_Daily-workflow features mobile has that web doesn't yet. Ordered by how often they're used._

### Plaid (bank sync)
- [x] **Plaid Link for Web** integration — `react-plaid-link` (`usePlaidLink` in `SettingsPage.tsx`), both create mode (Connect Bank) and update mode (Reconnect, passing `item_id` to `plaid_create_link_token`). _Found already shipped while auditing this list 2026-07-25 — predates this session, no closing commit on hand, verified by reading the current code rather than by having built it._
- [x] **Manual sync trigger** — "Sync Now" / "Force Full Resync" buttons, calls `plaid_sync_transactions`. See [`docs/features/settings.md`](docs/features/settings.md#bank-connections). _Extended 2026-07-25 (`plaid_sync_transactions` v33): non-`PRODUCT_NOT_READY` errors used to be `console.error`-only while the response still said `success: true`, so a dead connection (AmEx, `ITEM_LOGIN_REQUIRED`) rendered a green "Connected" badge for 113 days. Now maps reconnect-class codes to `plaid_items.status='login_required'`, everything else to `'error'`, and returns warnings the client surfaces. Plus a `status`-independent "stale" badge keyed on `last_synced_at` age, which catches failure modes no error code classifies._
- [x] **Bank account management page** — per-institution card lists its accounts; per-account rename (`display_name`) and `sync_enabled` toggle; Disconnect via kebab → confirm → `plaid_remove_item`. See [`docs/features/settings.md`](docs/features/settings.md#per-account-controls). _Same caveat as Plaid Link above: predates this session, verified by reading current code, not by building it._
- [x] **Settings page** — exists at `/settings` (`SettingsPage.tsx`): Bank Connections + Custom Categories sections. See [`docs/features/settings.md`](docs/features/settings.md). CSV import and tax settings, named in this item's original scope, are NOT part of it — those stay open below under their own items.

- [x] **Deploy `plaid_sync_transactions` v33** — _Deployed 2026-08-25._ Plaid errors now surface correctly; reconnect-class codes set `status='login_required'`, others set `'error'`.
- [x] **`plaid_exchange_token`: reset item status on update-mode reconnect** — Closed by `plaid_exchange_token` v17: update mode now resets `plaid_items.status = 'active'` immediately on success.
- [x] **Guard against duplicate connections re-importing history** — Closed by `plaid_exchange_token` v17: pre-exchange account_id detection prevents new items from being created for existing accounts; Keep/Fresh modal gives user control. `transactions.plaid_account_id` column enables targeted deletion on Fresh.
- [x] **"Start Fresh" path does not clean up receipt storage blobs** — `plaid_exchange_token` v17's fresh-path `.delete()` removed transaction rows but not any `receipts` storage objects attached to them (unlike `plaid_sync_transactions`' removal path which does clean up). _Fixed in source 2026-08-27 as v18: select `receipt_url` for the affected `plaid_account_id`s before deleting, `storage.remove()` them, then delete the rows — same pattern `plaid_sync_transactions` already uses. **Not yet deployed** (no Supabase CLI/credentials in this session) — see Deployment note in `docs/supabase-schema.md`._
- [x] **Deploy `plaid_exchange_token` v18** — receipt-blob cleanup on the Fresh-reconnect path (previous item) is source-only as of 2026-08-27; run `supabase functions deploy plaid_exchange_token` before it takes effect. Until deployed, a Fresh reconnect on an account with receipts attached still orphans those files in the bucket. _Deployed 2026-09-23._

### CSV Import
- [x] **Marketplace CSV import UI** — eBay Transaction Report, Amazon Settlement/Transaction View, Mercari CSV; drag-and-drop or file input calling `import_marketplace_csv` edge function (already shared with mobile — v16) — _Closed 2026-08-26: file upload cards in SettingsPage; calls import_marketplace_csv (v16) + sync_csv_orders_to_sales (v1)._
- [x] **Settlement Status view** — port of mobile's `SettlementStatusView`/`SettlementDetailView`: segmented platform picker, Needs Breakdown / Breakdown Imported sections, disbursement matching UI — _Closed 2026-08-26: eBay + Amazon settlement groups in SettingsPage; CSVGroupDetailSlideOver handles match/unlink._
- [x] **CSV → Sales auto-sync** — verify `syncCSVOrdersToSales` (already runs server-side per mobile's notes) surfaces correctly in the web Sales table once CSV import ships — _Closed 2026-08-26: sync_csv_orders_to_sales edge function (v1) — groups csv_import transactions by notes field, upserts sales rows; fixes mobile shipping/duplicate/return_status bugs._

### Categorization
- [x] **Custom Schedule C categories** — Shipped 2026-06-25 (see [`docs/superpowers/specs/2026-06-25-custom-categories-design.md`](docs/superpowers/specs/2026-06-25-custom-categories-design.md)). Supabase-backed `custom_categories` table with hybrid tax mapping (parent_value inherits from a built-in, or schedule_line maps directly to a Schedule C line). Inline management via `ManageCategoriesModal` reachable from every category dropdown. Soft-delete tombstones keep historical math intact. _Closed by `7166b87`…`b6b38db`._
- [x] **Bulk categorize** — Shipped 2026-07-10. Checkbox column + select-all in the Expenses table; a floating bar assigns one category to all selected rows via a single `.in('id', ids)` update (`bulkUpdateCategory`). Trade-linked rows are excluded (locked category); selection resets on filter change. See [`docs/features/expenses.md`](docs/features/expenses.md#bulk-categorize).
- [x] **Quick categorize from list** — inline category change without opening detail panel. _Verified 2026-08-27: already on par — clicking a row's `CategoryBadge` opens the shared `CategoryDropdown` as a fixed-position popover right there in the table (`ExpensesPage.tsx`'s `openDropdown`/`ddTxId`), no detail panel required. No code change needed; closing the item._
- [x] **Period chip filter + sort** in Expenses — mobile has Date/Amount/Merchant sort with asc/desc toggle and a richer period preset/account filter sheet; web only has the basic period picker + search + single category filter today. _Audited + closed 2026-08-27: the "period chip" and "account filter sheet" halves turned out to already be shipped (this item was stale) — `PeriodPicker` is chip-style pill buttons (shared across every page), and direction/source/account `<select>` filters were added by an earlier, undocumented commit (`7724032`). The one real gap was sort: added clickable Date/Merchant/Amount column headers with an asc/desc toggle (`sortField`/`sortDir` state, a `sorted` memo layered on top of `filtered`, default desc for Date/Amount and asc for Merchant, Amount sorts by signed value not magnitude). See [`docs/features/expenses.md`](docs/features/expenses.md#list-view)._

### Receipts
- [x] **Receipt attachment** — file upload to the existing private `receipts` Supabase Storage bucket (already created for mobile, RLS user-scoped); replace + delete in the transaction detail slide-over. _Shipped 2026-08-27: `ReceiptSection` + `uploadReceipt`/`replaceReceipt`/`deleteReceipt`/`getReceiptSignedUrl` in `mutations.ts`. View opens the file via a signed URL in a new tab rather than an inline preview — no thumbnail/lightbox yet. See [`docs/features/expenses.md`](docs/features/expenses.md#receipt-attachment)._
- [x] **Verify `receipts` bucket RLS policy matches the path convention the new upload UI assumes** — `uploadReceipt` (2026-08-27) writes to `{user_id}/{transaction_id}-{timestamp}.{ext}`, assuming the bucket's storage.objects policy keys off the first path segment matching `auth.uid()` (the standard Supabase private-bucket pattern, and consistent with how `plaid_sync_transactions` already reads `receipt_url` as a path). _Confirmed 2026-09-23: all four policies (SELECT/INSERT/UPDATE/DELETE) use `(storage.foldername(name))[1] = (auth.uid())::text` — exact match._

### Returns
- [x] **Return/refund UI** — "Process Return" button in Sale detail calling `record_return` edge function. Shipped: `ProcessReturnModal` + `recordReturn` mutation wrapper (button hidden only for trade-linked sales, relabels to "Edit Return" once a return exists). Also shipped: editing a return (delete + re-record via new `reverse_return` edge function), an optional return-shipping-cost field on the return (seller-paid label cost, posted as a `shipping_postage` transaction), and Sales-tab Net Payout now sums all `related_sale_id`-linked transactions so refunds/return-shipping show up as a (often negative) net payout. **`reverse_return` and `record_return`'s new `return_shipping_cost` param are undeployed** — see `docs/supabase-schema.md` Deployment note. Design: [`docs/superpowers/specs/2026-07-10-returns-design.md`](docs/superpowers/specs/2026-07-10-returns-design.md).
- [x] **CSV return reconciliation** — detect refund + return-shipping rows in imported eBay/Amazon transactions, match to sales by `external_order_id`, and route them through the same inventory-restoring `record_return` primitive (re-tagging existing CSV rows, not duplicating) via a review queue. Hybrid model chosen in the returns design doc; depends on "Marketplace CSV import" + "Settlement Status view" above. _Built 2026-08-27: `src/lib/csvReturns.ts` (detection/matching), `ReturnReconciliationSection` + `ReconcileReturnModal` (Settings → Marketplace CSV tab), `record_return`/`reverse_return` v2 (re-tag/un-tag instead of insert/delete for `source: 'csv_import'`), migration `20260827120000_csv_return_reconciliation.sql` (`returns.refund_transaction_id`/`return_shipping_transaction_id`). See [`docs/superpowers/specs/2026-08-27-csv-return-reconciliation-design.md`](docs/superpowers/specs/2026-08-27-csv-return-reconciliation-design.md). Migration + functions deployed 2026-09-23._
- [x] **Deploy the CSV return reconciliation migration + `record_return`/`reverse_return` v2** — source-only as of 2026-08-27 (no Supabase CLI/credentials in that session). This one is a live-data risk, not just a no-op: the live (pre-v2) `record_return` silently ignores the new `refund_transaction_id`/`return_shipping_transaction_id` params and falls through to the manual path, inserting a duplicate `returns_allowances` transaction while leaving the original CSV refund row untouched — **double-deducting the same real-world refund**. Run the migration, then `supabase functions deploy record_return reverse_return`, before anyone clicks "Apply Return" in the new Return Reconciliation section. _Migration already applied; both functions deployed 2026-09-23._
- [x] **Deploy return edge functions** — _Deployed 2026-08-25._ `reverse_return` and `record_return` (with `return_shipping_cost` param) are live.
- [x] **Clean up `TODO(p1-returns)` markers in `DashboardPage.tsx`** — their premise ("when the refund UI ships, `returns_allowances` rows should visually subtract from Line 1 via `bucketTransaction`") is superseded: `record_return`'s refund row is sale-linked, so `bucketTransaction` excludes it, and the "Gross Receipts − Returns = Line 1" presentation now lives in the shipped Schedule C **Summary export** (`buildScheduleCSummaryCSV`, Line 1 / Line 2 split). Remove or re-point the inline markers; see the note in `docs/categories.md` "Returns & Allowances".

### Export
- [x] **CSV export** — Shipped 2026-07-10. Dashboard "Transactions CSV" button downloads the period's business transactions via `src/lib/csvExport.ts`. Scope = all business rows (strips `isExcluded` + settlement rows, keeps sale-linked + uncategorized); `abs()` amount + `Type` direction column; `Platform` + `Gross Amount` columns. Unit-tested. See [`docs/features/dashboard.md`](docs/features/dashboard.md#csv-export-two-buttons).
- [x] **Schedule C Summary export** — Shipped 2026-07-10. Dashboard "Summary CSV" button: one row per IRS line + net profit (`computeScheduleCSummary`/`buildScheduleCSummaryCSV`). Same all-business-row source as the transaction export (ties out); returns kept on Line 2 (not netted into Line 1); meals halved on Line 24b; COGS (Line 4) = `cost_of_goods` purchase transactions (cash-basis, stated in the CSV header) rather than FIFO cost-of-goods-sold; uncategorized rows reported separately. Unit-tested. See [`docs/features/dashboard.md`](docs/features/dashboard.md#summary-csv-buildschedulecsummarycsv--computeschedulecsummary).

### Settings / Misc
- [x] **Merchant auto-categorization rules** — `category_rules` table + `apply_category_rules` RPC + rule hint row in transaction detail + Settings → Categories rules section. Plaid `merchant_entity_id`-keyed, upsert on `(user_id, merchant_entity_id)`, applied at sync time + on-demand backfill. _Shipped 2026-09-28. See [`docs/superpowers/specs/2026-09-23-merchant-auto-categorization-design.md`](docs/superpowers/specs/2026-09-23-merchant-auto-categorization-design.md)._

---

## 🟠 P2 — Tax Compliance & Filing

_Same priority tier as mobile's P2 — port once the core workflow above is solid._

- [x] **~~BLOCKER~~ Decided 2026-11-09: traditional §471.** _Build `inventory_valuations` (next item) and rewrite the box-opening spec's NIMS premise._ Original note: **decide the inventory accounting method before building any Part III card** — the docs currently assert **two mutually exclusive methods**, and the choice determines whether the next item should be built at all:
  - [`docs/features/dashboard.md`](docs/features/dashboard.md) documents the **§471 capitalize** model — `COGS = Beginning + Purchases − Ending`, which *requires* per-tax-year inventory valuations.
  - The box-opening spec states NIMS **§471(c)** was adopted — deduct at the later of paid-or-sold, which **needs no inventory valuation at all**. That's the simplification §471(c) buys.

  Both put a cost in the same year as its sale, so neither is "wrong" — but implementing one while documenting the other guarantees an inconsistent Part III. If NIMS: **drop the `inventory_valuations` item below entirely** and show deductions by later-of-paid-or-used. If §471: build it, and rewrite the box-opening spec's premise. This is a filing-method question for whoever signs the return, not an implementation detail — get it answered, then write it down as the single source of truth. Worked example that surfaced it: a bag bought 2025 / sold 2026 cannot be both "COGS in 2025" and "carried in ending inventory 2025" — the latter is precisely the mechanism that defers the cost to 2026, and doing both double-deducts.
- [x] **Inventory valuation (Beginning/Ending) stored in Supabase** — built 2026-11-09 as step 3 (`inventory_valuations` table + Part III card + Summary CSV Part III for full-year exports). See `docs/features/dashboard.md` "Part III". Migration applied separately (see Books Cleanup).
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
- [ ] **Mobile-friendly layout** — responsive design for phone browsers: touch-friendly tap targets, stacked layouts on small screens, collapsible nav, slide-overs and modals that don't overflow viewport. Promoted from P5.

### Inventory views
- [ ] **Pre-populate breakdown from a sale** — when creating a breakdown (OpenBoxModal), let the user pick an existing sale (e.g. a TCGPlayer order) and auto-populate the child lot names from that sale's `products[]` / `item_name`, so they don't have to type each card manually. TCGPlayer orders already carry per-card names via the Tampermonkey export → `import_tcgplayer_orders` → `item_name`. UX: "Import from Sale" button in the breakdown modal that opens a sale picker (filtered to same platform/date), then pre-fills the lot name rows.
- [ ] **Inventory filters** — filter by status (in stock / sold out / partially sold), item category/tag, lot type (purchased / trade-acquired / box-opened), and date-range for when lots were added; persist filter state across nav
- [ ] **Inventory view modes** — toggle between the current expandable list and a card/grid view; a "compact" table mode showing all lots flat (useful for large collections) with sortable columns (item name, units remaining, unit cost, total value)
- [ ] **Breakdown history view** — dedicated view of all past box openings: list of breakdowns with open date, source item, number of child lots created, and total basis allocated; tap/click a row to open `BoxOpeningDetailSlideOver` for the full child-lot breakdown
- [ ] **Trades history view** — dedicated view of past trades in the Inventory tab: list of trades with date, items sent/received, and net cost basis impact; tap/click to open `TradeDetailSlideOver`; complements the existing Sales-tab trade markers

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
