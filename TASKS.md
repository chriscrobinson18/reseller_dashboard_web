# Reseller Dashboard (Web) — Task Tracker

Open work only. How things work lives in [`docs/`](docs/README.md); the books-cleanup decisions and history live in [`docs/books-cleanup-handoff.md`](docs/books-cleanup-handoff.md). When an item is done, move what was learned into the matching doc and leave a one-line entry under **Done**.

**This repo is public:** no amounts, merchant names, account numbers, order numbers or personal names here. Keep those in chat or private notes.

Web is the primary client; it shares one Supabase project/schema with the iOS app (`reseller_dashboard`), so backend fixes benefit both.

---

## 🧹 Books cleanup — 2025 amended return + 2026 filing

> New session? Start with [`docs/books-cleanup-handoff.md`](docs/books-cleanup-handoff.md).

**Phases**
- [ ] **Phase 2: classify incoming money.** The Tie-Out card lists wallet deposits (PayPal, Zelle, Cash App, Venmo) in 2025 and 2026 with no recorded sales. For each deposit decide: a sale (→ Phase 3) or a transfer / personal item. Also any uncategorized credits on business accounts.
- [ ] **Phase 3: missing sales.** P2P, cash, Whatnot / Facebook and other non-imported sales for 2025–26, from wallet statements and records. One-off loads through the same code path as Record Sale; one summary sale per channel per month where line detail is gone. Includes one grading-company consignment sale (October 2025) whose deposit has no sale.
- [ ] **Set a payment method on every in-person sale** that has none (the Tie-Out flags them; they can't be matched to a wallet otherwise). Then check the in-person sales paid by Venmo in 2026 that have no Venmo deposit.
- [ ] **Phase 4: missing expenses.** Business expenses that never reached the bank (cash at shows, purchases from wallet balances). Also check statements of accounts the app doesn't sync (a closed checking account, the unlinked business account) for business expenses.
- [ ] **Phase 5: year-end inventory values.** Enter 2024 ending (from the filed return), then confirm 2025 and 2026 in the Part III card (lot-based estimates are shown until saved).
- [ ] **Phase 6: close each year.** Before closing 2026, re-import November–December: eBay Order Earnings + Transaction Report, Amazon report, TCGplayer orders. Then Schedule C per line for 2025 and 2026, compare 2025 with the filed return, hand to the preparer (1040-X decision) with the [open questions](docs/books-cleanup-handoff.md#open-questions-for-the-preparer).

**Owner actions**
- [ ] **Ask TCGplayer support about the cancelled January 2026 payout** (initiated to the closed checking account, cancelled the next day, never re-sent per the payout history). It's the only unexplained TCGplayer money.
- [ ] **Held for manual review:**
  - Credit-line payments tagged `cost_of_goods` (5 rows, early 2025): if the purchases they paid for are already in the books they double-count → `transfer`; otherwise record those purchases, then re-tag.
  - A retailer charge (September 2025) that includes a membership fee: split the membership into "Memberships" (Line 27a).
  - Memberships recorded as inventory lots (several subscriptions): remove the lots and move that part of each charge out of cost of goods.
  - A possible second charge for a multi-unit order (same day and card, slightly below the order total): unused; one sale stays one unit short.
  - Two orphaned cost-of-goods half-pairs (one 2025, one 2026) carry a `net_zero_pair_id` whose partner no longer exists, so they're excluded: if real purchases, **Unpair** them. 22 orphaned `transfer` half-pairs (no Schedule C effect): tidy when convenient.
  - One inventory unit whose second purchase isn't in the bank data.
  - Two transfers on one day in March 2026 appear twice on both sides (duplicate copies from a reconnect; excluded, so no tax effect): delete the extra copies.
- [ ] **Amazon purchase review (tabled):** split Amazon card charges into subscriptions / supplies / cost of goods using the order-history export, matched by date + amount.
- [ ] **Check the Tie-Out card layout** on a phone (no sideways scroll at 320–430px) and on desktop.

**Code follow-ups**
- [ ] **Amazon refunds are netted into Line 1:** the sync stores `sale_price` = gross − refunds and leaves `refunded_amount` empty, so refunds never reach Line 2 (1099-K mismatch risk). Store gross in `sale_price` and refunds in `refunded_amount`, as eBay does. Money-math change: review the 2025 numbers first.
- [ ] **TCGplayer import ignores `refunds[]`:** set `refunded_amount`, reduce `fees` by the refunded fee, and treat canceled-after-import orders as full returns ([reconciliation.md](docs/reconciliation.md#tcgplayer)). Existing cases were fixed by hand.
- [ ] **Return-shipping cost from in-app returns never reaches Schedule C:** `record_return` posts it as a sale-linked `shipping_postage` row (excluded as sale-derived) and doesn't add it to the sale. No affected rows yet. Count sale-linked return-shipping rows on Line 27a, with a test.
- [ ] **"Close Box" write-off double-deducts under the traditional method:** `closeBoxOpening` posts a new `cost_of_goods` row for the unallocated pool, but the box was already a purchase (Line 4 = beginning + purchases − ending). Stop posting it (leftover cards just leave ending inventory). No such rows exist yet ([features/inventory.md](docs/features/inventory.md)).
- [ ] **Pin `npm:plaid@47.0.0` in production-only Plaid functions** (`plaid_create_link_token`, `plaid_backfill_*`) wherever they're maintained ([operations.md](docs/operations.md#edge-functions)).
- [ ] **Backfill `plaid_account_id` on rows the old cron inserted** (from `account_display` + `plaid_accounts.mask`); Force Full Resync fills the other metadata. Then **consolidate duplicate `plaid_accounts` rows** (11 masks listed 2–3 times), with a backup.
- [ ] **6 manual 2026 sales have no stored `net_payout`** (math falls back to price − fees − shipping): backfill.
- [ ] **Sales page sends every sale ID in one URL** (`.in('related_sale_id', saleIds)`): chunk it before long periods hit URL-length limits.
- [ ] **Confirm the on-demand sync live:** one manual **Sync Now** from Settings (not run since the 2026-11-09 deploy).

---

## 🟠 P2 — Tax compliance & filing

- [ ] **Self-employment tax estimate** — SE tax widget (15.3% on net profit up to the SS wage base) on the Dashboard
- [ ] **1099-K reconciliation view** — enter 1099-K amounts per platform, compare to recorded gross per platform
- [ ] **Settlements warning on export** — warn on CSV export if the period has unexplained tie-out differences
- [ ] **Attach real cost transactions to a sale (many-to-many)** — a sale's real costs often arrive as separate charges (a label bought days later, one label charge covering several orders). Wants a `sale_transactions` join table (`sale_id`, `transaction_id`, `allocated_amount`, `kind`) mirroring [`inventory_lot_transactions`](supabase/migrations/20260724120000_lot_transaction_links.sql) (including its primary-link trigger): attach N cost transactions to one sale and split one across N sales; per-sale profit reads attached actuals over typed estimates (the `allocated_*` read-time pattern bundles use); attaching a real bank row must supersede the typed `shipping_postage` value, never add to it.
- [ ] **Accounting method disclosure** — state the method (income from recorded sales, traditional inventory) in a tax-settings page and the export header
- [ ] **Receipt coverage warning** — flag cost-of-goods transactions over a threshold with no receipt
- [ ] **Quarterly estimated tax calendar** — payment dates + estimates from YTD net profit

## 🟡 P3 — UX & dashboard polish

- [ ] **Top selling items card** on the Dashboard
- [ ] **Per-platform sales breakdown card** on the Dashboard + filter in the Sales table
- [ ] **Plaid webhooks** — `TRANSACTIONS` webhook instead of relying on manual/cron sync, plus the `ITEM` family (`ERROR`, `PENDING_EXPIRATION`, `USER_PERMISSION_REVOKED`, `LOGIN_REPAIRED`); only an `ITEM` webhook catches an auth failure without a manual sync (today the stale badge catches it, reactively).
- [ ] **Duplicate / anomaly detection** — flag same amount + merchant within 3 days as candidates for review (never auto-delete; same-day repeats are usually genuine)
- [ ] **Low stock alerts** — per-item threshold, in-app badge
- [ ] **Realtime updates** — Supabase Realtime on `transactions` / `sales` so multiple tabs stay current
- [ ] **Mobile layout follow-ups** — see [mobile-layout.md](docs/mobile-layout.md) for the rules; audit remaining pages against them

**Inventory views**
- [ ] **Pre-populate a breakdown from a sale** — "Import from Sale" in `OpenBoxModal` to prefill child lot names from a sale's `item_name` / products (TCGplayer orders carry per-card names)
- [ ] **Inventory filters** — status (in stock / sold out / partial), category, lot type (purchased / trade / breakdown), date added; persist across navigation
- [ ] **Inventory view modes** — card/grid view and a flat sortable lot table
- [ ] **Breakdown history view** — all past breakdowns (date, source item, child lots, basis), opening `BoxOpeningDetailSlideOver`
- [ ] **Trades history view** in Inventory, opening `TradeDetailSlideOver`

## 🟢 P4 — Advanced tax & compliance

- [ ] Year-end close wizard
- [ ] Accountant export package (zip: Schedule C summary + transaction CSV + uncategorized list + tie-out + cost-of-goods-without-receipt list), generated server-side
- [ ] Multi-year P&L comparison
- [ ] 1099-NEC contractor tracking
- [ ] Retirement contribution estimate
- [ ] Home office deduction setup
- [ ] Vehicle expense method selector
- [ ] Loan interest split
- [ ] Mixed-use asset allocation
- [ ] Prior-year amended return warning

## 🔵 P5 — Future / deferred

- [ ] **PayPal / Venmo / Cash App statement import** (would speed up Phases 2–3)
- [ ] **Bank CSV import** for institutions not on Plaid (and closed accounts' statements)
- [ ] **Amazon / eBay API integration** (Amazon's developer fee; eBay is free — activate first when scaling)
- [ ] **Multi-user / shared business**

## 🔄 Trades v2

- [ ] **Atomic `recordTrade`** — v1 is client-orchestrated; a mid-flight failure leaves partial state (the error shows the `tradeId` so `deleteTrade` can clean up). Move to a transactional edge function.
- [ ] **`updateTrade`** — v1 is delete + re-record; build a real edit once the atomic function exists.
- [ ] **Cash-flow views filter `is_non_cash = false`** when such a view ships.
- [ ] **iOS trade UI** — schema is additive; add when iOS is active again.

## 🗄️ Schema gaps

- [ ] No inventory adjustment for personal-use withdrawal / shrinkage (must be excluded from cost of goods)
- [ ] No `quantity` on `transactions` (CSV multi-unit sales hardcode 1)
- [ ] No `tax_profiles` table (Schedule C header fields, home office, vehicle method)
- [ ] No `sales_tax` column on `sales` / `transactions` (can't prove Line 1 excludes pass-through sales tax)
- [ ] Verify RLS on `marketplace_connections.access_token` / `refresh_token` is service-role-only

---

## Done

Details are in the linked docs.

- **2026-11-13** — eBay reconciled against eBay's own files; Transaction Report import fixed and re-imported ([reconciliation.md](docs/reconciliation.md#ebay)). eBay card/bank charges → `settlement`; store subscription counted from the report; tie-out ghost check. TCGplayer payouts outside the bank feed added; TCGplayer refunds fixed from the order export. Amazon prior-year refunds booked in the year paid. Tie-out: ledger bridge for eBay/Amazon, payment-method matching for in-person sales, payout-timing rule for TCGplayer ([features/dashboard.md](docs/features/dashboard.md#year-end-tie-out)). Dashboard: cost of goods sold separated from expenses, inventory on hand, Part III lot-based estimates. Split payments, all-or-nothing sale/bundle recording. Review markers ([supabase-schema.md](docs/supabase-schema.md#review-markers-review_status-added-2026-11-13)).
- **2026-11-12** — Inventory lots from order emails, net-zero charge/refund pairs, sales linked to lots, duplicate items merged, lot purchase dates backfilled, `link_sale_to_item` RPC ([features/inventory.md](docs/features/inventory.md#lot-data-rules-books-cleanup)).
- **2026-11-10** — No deposit is income (all re-tagged); Year-End Tie-Out card; 1000-row cap fix (`fetchAllRows`); data health check.
- **2026-11-09** — Sales-based Schedule C income; Part III traditional method (`inventory_valuations`); Phase 1 categorization; Plaid sync fixes (shared sync logic, deposit-only settlements, async cron, pinned `plaid`); re-import-safe marketplace imports; trade income double count fixed.
- **2026-09** — Merchant auto-categorization rules; Plaid duplicate prevention and orphan scan; CSV return reconciliation; TCGplayer order import; eBay Order Earnings import; bundles, trades and breakdown pages.
- **2026-08** — Marketplace CSV import + settlement status; receipts; bulk and inline categorize; Expenses sort; Breakdown Inventory (box opening); Apple Shortcuts quick entry.
- **2026-07** — Capitalized lot cost adjustments (grading); multi-transaction lot funding (`inventory_lot_transactions`); returns UI; CSV and Schedule C Summary exports; bulk categorize.
- **2026-06** — Web port foundation; P0 tax-correctness pass (signed bucketing, `record_return` cost basis, `reverse_sale`, Part III scope) — [spec](docs/superpowers/specs/2026-06-23-p0-tax-correctness-design.md); custom categories; trades v1.
