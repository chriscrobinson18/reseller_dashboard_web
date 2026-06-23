# Supabase

Project ref: `qmizmnbzergqbpgyqseg` — **shared with the sibling iOS app** (`reseller_dashboard`). Schema/RLS/edge-function changes affect both clients; there is one backend, two frontends.

⚠️ **Neither client repo contains the schema, migrations, RLS policies, or edge function source.** Everything below is reverse-engineered from how the web client queries/inserts data (`src/lib/queries.ts`, `src/lib/mutations.ts`, `src/lib/types.ts`, page-level fetches). Treat this file as the best available map, not ground truth — when in doubt, check the actual Supabase dashboard/CLI. Setting up `supabase link` + committing `supabase/` (migrations + `functions/`) to a repo is an open TASKS.md item; once that happens, this file should defer to the committed SQL instead of restating it.

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
| **no `deleted_at`** | transactions are **hard-deleted** (`deleteTransaction`), unlike every other table here |

### `sales`
The relational centerpiece — one row per sale event, FIFO-depletes inventory via the `record_sale` edge function.

| column | notes |
|---|---|
| `id`, `user_id`, `created_at`, `deleted_at` | soft-deleted |
| `item_id` | nullable — sales can arrive unlinked (e.g. from CSV import) and get linked later via `linkSaleToItem` |
| `platform`, `source`, `external_order_id` | |
| `quantity`, `sale_price` | `sale_price` is the **gross** unsigned sale amount |
| `fees`, `shipping_cost` | unsigned magnitudes, stored separately from `sale_price` |
| `net_payout` | computed client-side as `sale_price - fees - shipping_cost` and written back (see `recordSale`/`updateSale` in mutations.ts) — **not** server-computed |
| `inventory_status` | `'ok' \| 'oversold' \| 'reconciled'` — set by `record_sale` edge function based on FIFO depletion result |
| `return_status` | `'none' \| 'partial' \| 'full'` |
| `refunded_quantity`, `refunded_amount` | populated by the (not-yet-built-UI) `record_return` edge function |
| `sold_at` | full ISO timestamp (not just a date) |

Joins used: `items(id, name, category)`, `inventory_movements(id, quantity, inventory_lots(unit_cost, item_id))`.

### `items`
| `id`, `user_id`, `name`, `category`, `created_at`, `deleted_at` | soft-deleted; `category` here is a free-text/product category, unrelated to `schedule_c_category` |

### `inventory_lots`
A purchase batch of an item at a specific unit cost — FIFO unit of accounting.

| column | notes |
|---|---|
| `id`, `user_id`, `item_id`, `created_at`, `deleted_at` | soft-deleted |
| `transaction_id` | nullable FK to the COGS purchase transaction; `ON DELETE SET NULL` (deleting the transaction unlinks, doesn't delete, the lot) |
| `quantity_purchased`, `quantity_remaining` | `quantity_remaining` is depleted FIFO by `record_sale`; restored... nowhere yet (see "Deleting a sale doesn't reverse FIFO depletion" in TASKS.md — known bug) |
| `unit_cost` | |
| **no `purchase_date`** | only `created_at` exists; TASKS.md flags this as blocking correct FIFO ordering for back-dated entries |

### `inventory_movements`
Audit trail row created by `record_sale` per lot depleted by a sale. Read-only from the web client (`sale.inventory_movements`); join shape: `{ id, quantity, inventory_lots: { unit_cost, item_id } }`. `quantity * unit_cost` summed across a sale's movements = that sale's COGS.

## Tables referenced but not yet built on (per TASKS.md)
- `custom_categories` (planned — user-defined Schedule C categories, web-only improvement over mobile's UserDefaults approach)
- `category_rules` (planned — merchant auto-categorization)
- `inventory_valuations` (planned — Beginning/Ending inventory for Part III, must NOT be period-scoped)
- `tax_profiles` (planned — Schedule C header fields, home office sqft, vehicle method)
- `marketplace_connections` (exists per TASKS.md note "verify RLS on access_token/refresh_token is service-role-only" — unconfirmed)

## Edge functions

Not committed in this repo (see warning above). Known by name/contract from client usage:

- **`record_sale`** — `supabase.functions.invoke('record_sale', { body: { item_id, quantity, sale_price, platform, sold_at, source, external_order_id } })`. Inserts the `sales` row, FIFO-depletes `inventory_lots.quantity_remaining`, creates `inventory_movements` rows. Returns `{ sale_id, inventory_status, unfulfilled_quantity }`. Does **not** appear to persist `fees`/`shipping_cost` itself — the web client writes those onto the `sales` row in a follow-up `.update()` call (see `recordSale` in mutations.ts) — TASKS.md flags this as needing end-to-end verification.
- **`record_return`** — not called from any web UI yet (no Return/Refund button exists). Per TASKS.md, mobile's version has known bugs (uses `salePrice` instead of lot `unit_cost` for cost restoration, doesn't insert a refund `transactions` row) — fix in the shared function once web UI ships, don't port the bug.
- **`import_marketplace_csv`** — referenced in TASKS.md as already shared/working server-side (v16); no web UI calls it yet.
- Plaid functions: `plaid_create_link_token`, `plaid_exchange_token`, `plaid_sync_transactions` — referenced in TASKS.md, not called from web yet (Plaid Link for Web is a P1 item).

## Storage

- `receipts` bucket — private, user-scoped RLS, already created for mobile. No upload UI in web yet (`receipt_url` column exists on `transactions` but is unused).

## Open schema gaps (from TASKS.md, carried over from mobile's architectural review)

- No `quantity` column on `transactions` → CSV multi-unit sales hardcode `quantity: 1`.
- No `sales_tax` column on `sales`/`transactions` → can't prove Line 1 excludes pass-through sales tax.
- RLS on `marketplace_connections.access_token`/`refresh_token` being service-role-only is unconfirmed.
