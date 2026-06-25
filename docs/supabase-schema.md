# Supabase

Project ref: `qmizmnbzergqbpgyqseg` — **shared with the sibling iOS app** (`reseller_dashboard`). Schema/RLS/edge-function changes affect both clients; there is one backend, two frontends.

⚠️ **Partial source of truth in-repo as of 2026-06-23.** The web repo's [`supabase/`](../supabase/) tree contains the migrations and edge functions touched in the P0 tax-correctness pass (`reverse_sale` RPC; `record_sale` / `record_return` / `reverse_sale` edge functions). Everything else (table DDL, RLS policies, the other edge functions, Plaid/CSV/marketplace functions) is still reverse-engineered from how the web client queries/inserts data (`src/lib/queries.ts`, `src/lib/mutations.ts`, `src/lib/types.ts`, page-level fetches). Treat this file as the best available map for those areas, not ground truth — when in doubt, check the actual Supabase dashboard/CLI. Backfilling the rest of `supabase/` (table migrations, untouched edge functions) into the repo is an ongoing TASKS.md item.

## Auth

- Supabase Auth, email/password (see `LoginPage.tsx`). `supabase.auth.getUser()` is called by every mutation that needs `user_id` (see `getUserId()` in `mutations.ts`).
- RLS auto-scopes `SELECT` by the authenticated user — client code never adds a `user_id` filter on reads. `INSERT`s **must** set `user_id` explicitly; RLS won't fill it in.

## Tables (inferred)

### `transactions`
Bank/manual/CSV-sourced money movements — the Schedule C source of truth for income/expenses.

| column | notes |
|---|---|
| `id`, `user_id`, `created_at` | |
| `date` | `'yyyy-MM-dd'` |
| `amount` | **signed** numeric; negative = expense, positive = income |
| `gross_amount` | optional, present on some rows (e.g. settlements) |
| `merchant`, `type`, `notes`, `account_display` | |
| `source` | `'plaid' \| 'manual' \| 'csv_import'` |
| `platform` | marketplace name, when relevant |
| `record_type` | `'transaction' \| 'settlement'` |
| `schedule_c_category` | FK-ish string into `CATEGORIES` (see categories.md); nullable = uncategorized |
| `net_zero_pair_id` | shared UUID across two rows that cancel out (e.g. transfer pairs) — see `pairTransactions`/`unpairTransactions` |
| `related_sale_id` | set on the payout/fee/shipping rows auto-created by `recordSale` — links a transaction back to the `sales` row it came from |
| `parent_settlement_id`, `csv_transaction_id` | CSV-import/settlement linkage, not yet exercised by any UI in this repo |
| `plaid_transaction_id`, `plaid_category` | Plaid-sourced rows only; read-only in the UI (`TransactionDetail` blocks editing date/amount/merchant/direction when `source === 'plaid'`) |
| `receipt_url` | referenced in `types.ts`; no upload UI exists yet (see receipts bucket below) |
| `is_non_cash` | boolean, default `false`; marks non-cash trade-leg income and COGS rows. Included in Schedule C totals; excluded from bank-reconciliation/cash-flow views. |
| `trade_id` | nullable FK to `trades`; set on all transactions related to a trade (income, COGS, optional cash boot). `ON DELETE SET NULL`. |
| **no `deleted_at`** | transactions are **hard-deleted** (`deleteTransaction`), unlike every other table here |

### `sales`
The relational centerpiece — one row per sale event, FIFO-depletes inventory via the `record_sale` edge function.

| column | notes |
|---|---|
| `id`, `user_id`, `created_at`, `deleted_at` | soft-deleted |
| `item_id` | nullable — sales can arrive unlinked (e.g. from CSV import) and get linked later via `linkSaleToItem` |
| `platform`, `source`, `external_order_id` | `source` values: `'plaid' \| 'manual' \| 'csv_import' \| 'trade'`. Trade-leg sales set `source = 'trade'`. |
| `quantity`, `sale_price` | `sale_price` is the **gross** unsigned sale amount |
| `fees`, `shipping_cost` | unsigned magnitudes, stored separately from `sale_price` |
| `net_payout` | computed client-side as `sale_price - fees - shipping_cost` and written back (see `recordSale`/`updateSale` in mutations.ts) — **not** server-computed |
| `inventory_status` | `'ok' \| 'oversold' \| 'reconciled'` — set by `record_sale` edge function based on FIFO depletion result |
| `return_status` | `'none' \| 'partial' \| 'full'` |
| `refunded_quantity`, `refunded_amount` | populated by the `record_return` edge function (v21, no web UI yet — P1) |
| `sold_at` | full ISO timestamp (not just a date) |
| `trade_id` | nullable FK to `trades`; set on the sale(s) for items given up in a trade. `ON DELETE SET NULL`. |

Joins used: `items(id, name, category)`, `inventory_movements(id, quantity, inventory_lots(unit_cost, item_id))`.

### `items`
| `id`, `user_id`, `name`, `category`, `created_at`, `deleted_at` | soft-deleted; `category` here is a free-text/product category, unrelated to `schedule_c_category` |

### `inventory_lots`
A purchase batch of an item at a specific unit cost — FIFO unit of accounting.

| column | notes |
|---|---|
| `id`, `user_id`, `item_id`, `created_at`, `deleted_at` | soft-deleted |
| `transaction_id` | nullable FK to the COGS purchase transaction; `ON DELETE SET NULL` (deleting the transaction unlinks, doesn't delete, the lot). On trade-acquired lots, points to the trade's `cogs_transaction_id`. |
| `quantity_purchased`, `quantity_remaining` | `quantity_remaining` is depleted FIFO by `record_sale`, restored by `reverse_sale` (on sale delete) and by `record_return` v21 (on partial/full refund) |
| `unit_cost` | |
| **no `purchase_date`** | only `created_at` exists; TASKS.md flags this as blocking correct FIFO ordering for back-dated entries |
| `trade_id` | nullable FK to `trades`; set on lots created from received-in-trade items. `ON DELETE SET NULL`. |

### `inventory_movements`
Audit trail row created by `record_sale` per lot depleted by a sale. Read-only from the web client (`sale.inventory_movements`); join shape: `{ id, quantity, inventory_lots: { unit_cost, item_id } }`. `quantity * unit_cost` summed across a sale's movements = that sale's COGS.

### `trades`
Barter exchange record — one row per trade event. See [`docs/superpowers/specs/2026-06-23-trades-design.md`](superpowers/specs/2026-06-23-trades-design.md) for the full accounting model and mutation sequence.

| column | notes |
|---|---|
| `id`, `user_id`, `created_at`, `deleted_at` | soft-deleted |
| `traded_at` | `'yyyy-MM-dd'` — date the trade happened; drives Schedule C date for all linked transactions |
| `counterparty` | nullable; free-text description of the other party ("John D. on IG", "@handle") |
| `given_fmv` | sum of given-side line FMVs — what your items were "sold" for in the barter |
| `received_fmv` | sum of received-side line FMVs — total basis going onto new lots |
| `cash_boot` | signed numeric; `+` = you received cash, `−` = you paid cash, `0` = pure swap |
| `cash_transaction_id` | nullable FK to the bank transaction for the boot; `ON DELETE SET NULL` |
| `income_transaction_id` | FK to the non-cash income `transactions` row (always `is_non_cash = true`); `ON DELETE SET NULL` |
| `cogs_transaction_id` | FK to the non-cash COGS `transactions` row (always `is_non_cash = true`); `ON DELETE SET NULL` |
| `fmv_source_notes` | nullable; IRS defensibility breadcrumb (e.g. "eBay sold comps saved 2026-06-23") |
| `notes` | nullable free text |

## Tables referenced but not yet built on (per TASKS.md)
- `custom_categories` (planned — user-defined Schedule C categories, web-only improvement over mobile's UserDefaults approach)
- `category_rules` (planned — merchant auto-categorization)
- `inventory_valuations` (planned — Beginning/Ending inventory for Part III, must NOT be period-scoped)
- `tax_profiles` (planned — Schedule C header fields, home office sqft, vehicle method)
- `marketplace_connections` (exists per TASKS.md note "verify RLS on access_token/refresh_token is service-role-only" — unconfirmed)

## Edge functions

Three are now committed in [`supabase/functions/`](../supabase/functions/) (the ones touched in the P0 pass). The rest are known by name/contract from client usage; they'll be backfilled into the repo as future passes touch them.

- **`record_sale`** ([source](../supabase/functions/record_sale/index.ts)) — `supabase.functions.invoke('record_sale', { body: { item_id, quantity, sale_price, platform, sold_at, source, external_order_id } })`. Inserts the `sales` row, FIFO-depletes `inventory_lots.quantity_remaining`, creates `inventory_movements` rows. Returns `{ sale_id, inventory_status, unfulfilled_quantity }`. **Does not persist `fees`/`shipping_cost`/`net_payout`** — the web client writes those onto the `sales` row in a follow-up `.update()` call (see `recordSale` in mutations.ts). Verified end-to-end in the P0 pass; the source has a contract header comment spelling this out.
- **`record_return`** (v21, [source](../supabase/functions/record_return/index.ts)) — no web UI calls it yet (P1). Fixed in the P0 pass: reverses `inventory_movements` LIFO and restores `quantity_remaining` on the original source lots at the lots' original `unit_cost` (no more fake new-lot-at-sale-price), and inserts a `transactions` row for the refund with `amount: -refund_amount`, `schedule_c_category: 'returns_allowances'`, `related_sale_id`, `source: 'manual'`.
- **`reverse_sale`** (v1, [source](../supabase/functions/reverse_sale/index.ts)) — thin wrapper around the `public.reverse_sale(uuid)` RPC. Invoked by the client's `deleteSale` mutation. Atomically restores depleted lots, deletes `inventory_movements`, deletes linked manual `transactions`, soft-deletes the sale. Errors mapped to 400/403/404/409 (404 = sale not found, 409 = already soft-deleted, replay guard).
- **`import_marketplace_csv`** — referenced in TASKS.md as already shared/working server-side (v16); no web UI calls it yet. Not committed in-repo.
- Plaid functions: `plaid_create_link_token`, `plaid_exchange_token`, `plaid_sync_transactions`, `plaid_sync_scheduled`, `plaid_remove_item`, `plaid_oauth_redirect`, `plaid_backfill_*` — not called from web yet (Plaid Link for Web is a P1 item). Not committed in-repo.
- Marketplace OAuth: `marketplace_auth_url`, `marketplace_exchange_token` — referenced in TASKS.md as part of the eBay/Amazon connect flow; no web UI yet.

## Postgres RPCs

- **`public.reverse_sale(p_sale_id uuid) RETURNS json`** ([migration](../supabase/migrations/20260623120000_reverse_sale_rpc.sql)) — `SECURITY DEFINER`, granted to `authenticated`. Locks the sale row, verifies `auth.uid()` matches `sales.user_id`, FOR UPDATE-locks the affected lot rows, restores `quantity_remaining`, deletes movements + linked manual transactions, soft-deletes the sale. Raises `sale_not_found` / `forbidden` / `already_deleted` on edge cases. Called only by the `reverse_sale` edge function; not exposed to the JS client directly.

## Storage

- `receipts` bucket — private, user-scoped RLS, already created for mobile. No upload UI in web yet (`receipt_url` column exists on `transactions` but is unused).

## Open schema gaps (from TASKS.md, carried over from mobile's architectural review)

- No `quantity` column on `transactions` → CSV multi-unit sales hardcode `quantity: 1`.
- No `sales_tax` column on `sales`/`transactions` → can't prove Line 1 excludes pass-through sales tax.
- RLS on `marketplace_connections.access_token`/`refresh_token` being service-role-only is unconfirmed.
