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

#### Plaid metadata fields (added 2026-06-26 by `plaid_metadata_capture`)

Populated by `plaid_sync_transactions` v32+. All nullable; absent when source ≠ `'plaid'`. Backfill on existing rows happens via the **Force Full Resync** kebab option in Settings — see [`features/settings.md`](features/settings.md).

| Column | Type | Source field |
|---|---|---|
| `merchant_logo_url` | `text` | `logo_url` |
| `merchant_website` | `text` | `website` |
| `merchant_entity_id` | `text` | `merchant_entity_id` |
| `location_city` | `text` | `location.city` |
| `location_region` | `text` | `location.region` |
| `location_store_number` | `text` | `location.store_number` |
| `payment_channel` | `text` | `payment_channel` (`'online' \| 'in store' \| 'other'`) |
| `authorized_date` | `date` | `authorized_date` |
| `iso_currency_code` | `text` | `iso_currency_code` |
| `pending` | `boolean NOT NULL DEFAULT false` | `pending` |
| `pending_plaid_transaction_id` | `text` | `pending_transaction_id` |
| `plaid_category_detailed` | `text` | `personal_finance_category.detailed` |
| `plaid_category_confidence` | `text` | `personal_finance_category.confidence_level` |
| `plaid_metadata` | `jsonb` | the entire raw Plaid transaction (safety net) |

### `sales`
The relational centerpiece — one row per sale event, FIFO-depletes inventory via the `record_sale` edge function.

| column | notes |
|---|---|
| `id`, `user_id`, `created_at`, `deleted_at` | soft-deleted |
| `item_id` | nullable — sales can arrive unlinked (e.g. from CSV import) and get linked later via `linkSaleToItem` |
| `item_name` | text | Nullable. Free-text item description from Shortcuts quick-sale. Preserved after `item_id` is linked. |
| `platform`, `source`, `external_order_id` | `source` values gated by the `sales_source_check` CHECK constraint (DB-side): `'manual' \| 'amazon' \| 'ebay' \| 'tcgplayer' \| 'csv_import' \| 'trade'`. **Adding a new value requires a migration to extend the constraint** — the TS `Sale.source` union is not authoritative for the DB. Trade-leg sales set `source = 'trade'`. (Note: the TS union also lists `'plaid'`, but the DB constraint does not — pre-existing drift; plaid sales aren't yet written from the web client.) |
| `quantity`, `sale_price` | `sale_price` is the **gross** unsigned sale amount |
| `fees`, `shipping_cost` | unsigned magnitudes, stored separately from `sale_price` |
| `net_payout` | computed client-side as `sale_price - fees - shipping_cost` and written back (see `recordSale`/`updateSale` in mutations.ts) — **not** server-computed |
| `inventory_status` | `'ok' \| 'oversold' \| 'reconciled'` — set by `record_sale` edge function based on FIFO depletion result |
| `return_status` | `'none' \| 'partial' \| 'full'` |
| `refunded_quantity`, `refunded_amount` | populated by the `record_return` edge function (v21), driven from the web `ProcessReturnModal` (shipped 2026-07-10); decremented by `reverse_return` on return-edit |
| `payment_method` | nullable text — how the buyer paid (`cash`, `venmo`, `cashapp`, `paypal`, `apple_pay`, `zelle`, `card`, `other`). **Orthogonal to `platform`**, which is *where* the sale happened: an eBay sale and a face-to-face sale can both settle over PayPal, and an in-person sale has no marketplace at all. Deliberately unconstrained — payment rails change faster than migrations, so the known list lives in `src/lib/paymentMethods.ts`. Null on sales predating the column. |
| `sold_at` | full ISO timestamp (not just a date) |
| `trade_id` | nullable FK to `trades`; set on the sale(s) for items given up in a trade. `ON DELETE SET NULL`. |

Joins used: `items(id, name, category)`, `inventory_movements(id, quantity, inventory_lots(unit_cost, item_id))`.

### `sale_bundles`
One sale event that disposes of several **different** items for one combined payout (multi-item marketplace order, or an in-person mixed lot). Added by the `sale_bundles` migration (2026-07-25).

| column | notes |
|---|---|
| `id`, `user_id`, `created_at`, `deleted_at` | soft-deleted |
| `sold_at` | `date` (not a timestamp, unlike `sales.sold_at`) |
| `platform`, `payment_method`, `external_order_id`, `notes` | order-level metadata, copied down onto each line for search |
| `fees`, `shipping_cost` | **order-level** — one number for the whole bundle, not per line |

Link columns: `sales.bundle_id` and `transactions.related_bundle_id`, both nullable + `ON DELETE SET NULL` (same pattern as `trade_id`).

**Why this shape.** `sales` holds a single `item_id`, and `record_sale` FIFO-depletes assuming one item per call. Restructuring `sales` into a header/line-item table would have touched FIFO depletion, `inventory_movements`, returns and `reverse_sale` — all of which already work for the single-item case. So this follows the `trades` precedent instead: each bundle item becomes an ordinary `sales` row (`source='manual'`, shared `bundle_id`) created through the untouched `record_sale` function, carrying its own user-entered price so per-item profit works unmodified.

**The part that can't live on a line.** Fees/shipping/payout are one number per order, not N. `trades` solved the equivalent problem by hanging transaction links off the trade row; this does the same via `related_bundle_id`, so `recordBundleSale()` creates exactly **one** payout/fee/shipping transaction set regardless of line count. Composing this from `recordSale()` would have fired `createSaleTransactions()` per line and multiplied the real payout by the number of items — the failure mode this design exists to avoid.

Bundle lines are stamped `fees=0`, `shipping_cost=null`, `net_payout=<line price>` explicitly (mirroring what `recordTrade` does for given-side sales), so the Sales list shows each line's own price and the true post-fee total lives only on the bundle.

### `items`
| `id`, `user_id`, `name`, `category`, `created_at`, `deleted_at` | soft-deleted; `category` here is a free-text/product category, unrelated to `schedule_c_category` |

### `inventory_lots`
A purchase batch of an item at a specific unit cost — FIFO unit of accounting.

| column | notes |
|---|---|
| `id`, `user_id`, `item_id`, `created_at`, `deleted_at` | soft-deleted |
| `transaction_id` | nullable FK to the COGS purchase transaction; `ON DELETE SET NULL`. **Denormalized** — mirrors the primary (oldest) row in `inventory_lot_transactions`, kept only for iOS compatibility. Web reads the join table instead. On trade-acquired lots, points to the trade's `cogs_transaction_id`. |
| `quantity_purchased`, `quantity_remaining` | `quantity_remaining` is depleted FIFO by `record_sale`, restored by `reverse_sale` (on sale delete) and by `record_return` v21 (on partial/full refund) |
| `unit_cost` | per-unit, 2dp — the **all-in current basis**, including any `lot_cost_adjustments` (grading, shipping to grader), not just the purchase price. A purchase total that doesn't divide evenly is split across **multiple lot rows** rather than rounded — see `splitLotCost` in [`features/inventory.md`](features/inventory.md#lot-cost-entry-and-penny-splitting). |
| `initial_unit_cost` | nullable numeric, added 2026-07-26. Per-unit basis at creation, before adjustments; backfilled to `unit_cost` for existing lots. Lets `unit_cost` be recomputed from the basis invariant instead of mutated incrementally — see [`features/inventory.md`](features/inventory.md#the-basis-invariant). |
| `purchase_date` | nullable `date`; set from the Add/Edit Lot modal date picker (defaults to today). Lots predating the column show `created_at` as a fallback in the UI. |
| `trade_id` | nullable FK to `trades`; set on lots created from received-in-trade items. `ON DELETE SET NULL`. |
| `box_opening_id` | nullable FK to `box_openings`; set on the single-unit lots created by breaking down inventory. `ON DELETE SET NULL`, added by the `box_openings` migration (2026-08-03). |

### `box_openings`
Audit-trail row for one "Breakdown Inventory" event — an existing inventory lot (a sealed box, a bundle) splitting into many single-card lots. UI/docs call this **Breakdown Inventory**; the table, columns, and `openBox`/`deleteBoxOpening` function names are unchanged from the original box-opening design (renaming those would touch a table already live in Supabase — deferred). Added by the `box_openings` migration (2026-08-03); `source_lot_id`/`quantity` added by `box_openings_source_lot` (same day). Written by `openBox`, soft-deleted (with cascading lot soft-delete, and quantity restored to the source lot) by `deleteBoxOpening`.

| column | notes |
|---|---|
| `id`, `user_id`, `created_at`, `deleted_at` | soft-deleted |
| `opened_at` | `date` — when the box was physically broken down; sets the resulting cards' `purchase_date` |
| `box_name`, `notes` | free text; `box_name` is captured from the source item's name at breakdown time, not user-typed |
| `box_cost` | positive numeric, `CHECK (box_cost > 0)` (nullable for shortcut-initiated incomplete breakdowns) — `source_lot.unit_cost × quantity`. **Not a Schedule C deduction** — the source lot's cost was already deducted when it was purchased and linked, same as any other lot. Breaking it down creates no transaction. |
| `transaction_id` | nullable FK to the `cost_of_goods` transaction, `ON DELETE SET NULL` — mirrors the source lot's purchase transaction for display only; not created or owned by this row |
| `allocation_method` | `'relative_fmv' \| 'specific_id' \| 'equal'`, CHECK-constrained (nullable until user completes the breakdown in the web app). Math lives in `src/lib/boxAllocation.ts` (`allocateBoxCost`) |
| `source_lot_id` | nullable FK to `inventory_lots`, `ON DELETE SET NULL` — the lot this was broken down from. `openBox` depletes its `quantity_remaining` by `quantity`; `deleteBoxOpening` restores it. |
| `quantity` | integer, `CHECK (quantity > 0)`, default 1 — units of the source lot broken down in this event |

Resulting cards are ordinary `inventory_lots` rows (`quantity_purchased = 1` each, `box_opening_id` set) mirroring the source lot's `transaction_id` — FIFO depletion, sales, and returns need no changes to handle them. No transaction is read or written by this flow at all, so the allocation choice never affects Schedule C, only the Profitability dashboard and per-sale profit. Why: [`features/inventory.md`](features/inventory.md#opening-a-box) and [`docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md`](superpowers/specs/2026-06-23-box-opening-and-grading-design.md).

### `inventory_lot_transactions`
Funding links between a lot and the transaction(s) that paid for it — added by the `lot_transaction_links` migration (2026-07-24) to support **split-tender purchases** (one eBay order paid part on a card that Plaid syncs, part from marketplace balance that never touches a bank).

| column | notes |
|---|---|
| `id`, `user_id`, `created_at` | |
| `lot_id` | FK to `inventory_lots`, `ON DELETE CASCADE` |
| `transaction_id` | FK to `transactions`, `ON DELETE CASCADE` (transactions are hard-deleted, so the link goes with it) |
| `allocated_amount` | unsigned magnitude this transaction contributed to the lot's cost; `check (>= 0)` |
| | `unique (lot_id, transaction_id)` |

**This table is the source of truth for the web client.** `inventory_lots.transaction_id` is kept as a denormalized mirror of the *primary* (oldest) link, purely so the sibling iOS app keeps working. Don't add new web reads against that column.

That mirror is maintained by the **`inventory_lot_transactions_sync_primary` trigger** (`sync_lot_primary_transaction()`, added 2026-07-24), which fires on insert/update/delete and recomputes the column in one statement. Do **not** maintain it from client code: the original client-side read-then-write raced — a concurrent link and unlink on the same lot could interleave so the stale reader won and left `transaction_id` pointing at an already-deleted link. The FK still resolved, so nothing errored; iOS simply showed a purchase link the web app no longer had. Being a trigger also keeps it correct for writers the web client never sees, including `ON DELETE CASCADE` from a hard-deleted transaction.

Two sums matter, and they answer different questions:
- **Per lot** — `sum(allocated_amount)` should equal `quantity_purchased * unit_cost`. Shortfall = the lot isn't fully funded (a payment method is missing). Surfaced in `LotTransactionSlideOver`.
- **Per transaction** — `sum(allocated_amount)` should equal `abs(transactions.amount)`. Shortfall = part of the purchase hasn't become inventory yet. Surfaced in `TransactionInventorySection`.

Migration backfills one link per already-linked lot at its full cost, so pre-existing data reconciles unchanged.

### `lot_cost_adjustments`
Costs added to a lot after creation and capitalized into its basis — grading fees, shipping to the grader. Added by the `lot_cost_adjustments` migration (2026-07-26). Written by `addLotCostAdjustment`, soft-deleted by `deleteLotCostAdjustment` and by `deleteLot`'s cascade.

| column | notes |
|---|---|
| `id`, `user_id`, `created_at`, `deleted_at` | soft-deleted; only non-deleted rows count toward basis |
| `lot_id` | FK to `inventory_lots`, `ON DELETE CASCADE` |
| `transaction_id` | nullable FK to the `cost_of_goods` transaction, `ON DELETE SET NULL` — the basis increase survives the transaction |
| `created_transaction` | boolean; true if this row posted its own transaction, false if it linked an existing one. **Governs deletion** — only a created transaction may be deleted with the adjustment; a linked (e.g. Plaid-synced) one is real history and is kept |
| `adjustment_type` | `'grading' \| 'shipping_to_grader' \| 'other'`, CHECK-constrained. Display list lives in `src/lib/lotAdjustments.ts`; adding a value needs a migration to extend the constraint |
| `amount` | positive numeric, `CHECK (amount > 0)`. Basis increases only |
| `incurred_on` | `date` — when the fee was paid; drives the transaction's Schedule C date |
| `grader`, `grade_received` | nullable free text (PSA/BGS/SGC…, "PSA 10"); `grade_received` is filled in after the card returns |
| `notes` | optional |

Why capitalized and not expensed, and why Schedule C doesn't double-count: [`features/inventory.md`](features/inventory.md#capitalized-cost-adjustments-grading-shipping-to-grader).

### `inventory_movements`
Audit trail row created by `record_sale` per lot depleted by a sale. Read-only from the web client (`sale.inventory_movements`); join shape: `{ id, quantity, inventory_lots: { unit_cost, item_id } }`. `quantity * unit_cost` summed across a sale's movements = that sale's COGS.

### `returns`
One row per return/refund event against a sale. Written by `record_return`, deleted by `reverse_return`, read by `fetchActiveReturn` (in `mutations.ts`) to pre-fill the edit-return form. The web UI (`ProcessReturnModal`) assumes **at most one active return per sale** — `fetchActiveReturn` takes the most-recent row. See [`docs/superpowers/specs/2026-07-10-returns-design.md`](superpowers/specs/2026-07-10-returns-design.md).

| column | notes |
|---|---|
| `id`, `user_id`, `created_at` | RLS-scoped; `created_at` is the ordering key for "most recent return" |
| `sale_id` | FK to `sales` |
| `quantity` | units returned; `record_return` validates `≤ sale.quantity − refunded_quantity` |
| `refund_amount` | buyer refund (money returned to the buyer); **excludes** the seller's return-shipping label cost |
| `reason` | nullable free text |
| `source` | `'manual'` today (the only path); reserved for `'csv_import'` when marketplace-return reconciliation ships |

The return's side effects live outside this table: `record_return` restores `inventory_lots.quantity_remaining` (LIFO), updates the sale's `refunded_*`/`return_status`/`inventory_status`, and inserts a `returns_allowances` refund `transactions` row (+ a `shipping_postage` row for the return label if given), all carrying `related_sale_id`. See the edge-function notes below and [data-flows.md](data-flows.md#revenue-net-of-returns).

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

### `custom_categories`
Per-user, tax-aware Schedule C categories. See [`docs/superpowers/specs/2026-06-25-custom-categories-design.md`](superpowers/specs/2026-06-25-custom-categories-design.md) for the full design.

| column | notes |
|---|---|
| `id`, `user_id`, `created_at`, `deleted_at` | soft-deleted; tombstoned rows are still SELECT-able so transactions referencing them resolve correctly |
| `name` | display label, ≤ 40 chars, soft-uniqueness scoped to the user's active rows (enforced client-side) |
| `color_key` | references one of 12 swatches in [`src/lib/categoryPalette.ts`](../src/lib/categoryPalette.ts); DB CHECK constrains the value set |
| `parent_value` | nullable text; when set, points to a built-in `CATEGORIES[].value` (e.g. `'commissions_fees'`). Inherits `scheduleLine`/`mealsHalf`/`isExcluded` from the parent at resolution time. Validated client-side against `CATEGORIES` (no DB CHECK — keeps migrations decoupled from the built-in list) |
| `schedule_line` | nullable text; mutually exclusive with `parent_value`. Allowed values: `'Part I' \| 'Part III' \| 'Line 8'…'Line 30'` excluding `'Line 24b'` (Line 24b must go via `parent_value = 'meals'` so the 50% deduction is inherited). Validated client-side |

**CHECK:** `(parent_value IS NOT NULL) <> (schedule_line IS NOT NULL)` — exactly one of `parent_value` / `schedule_line` is non-null.

`transactions.schedule_c_category` stores `cust_<uuid-no-hyphens>` for rows tagged with a custom category. No schema change to `transactions`.

### `profiles`
Per-user settings. `id` is FK → `auth.users`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, FK → `auth.users(id)` ON DELETE CASCADE |
| `shortcut_token` | uuid | Unique. Personal API token for Apple Shortcuts. Null = not configured. |

### `plaid_items`

One row per linked Plaid Item (institution). `plaid_accounts` is the per-account child table. Both are written exclusively by the Plaid edge functions; the web client only reads them and toggles `plaid_accounts.sync_enabled`.

| Column | Notes |
|---|---|
| `status` (`'active' \| 'login_required' \| 'error'`) | Health of the Plaid connection. Defaults to `'active'`. Written by `plaid_sync_transactions` on `ITEM_LOGIN_REQUIRED` and reset by `plaid_exchange_token` on update-mode success. Web client reads this to drive the "Reconnect needed" badge in Settings; treats the column as `'active'` if missing. |
| `error_message` | Optional human-readable Plaid error string, shown as a tooltip on the status badge. |

## Tables referenced but not yet built on (per TASKS.md)
- `category_rules` (planned — merchant auto-categorization)
- `inventory_valuations` (planned — Beginning/Ending inventory for Part III, must NOT be period-scoped)
- `tax_profiles` (planned — Schedule C header fields, home office sqft, vehicle method)
- `marketplace_connections` (exists per TASKS.md note "verify RLS on access_token/refresh_token is service-role-only" — unconfirmed)

## Edge functions

Three are now committed in [`supabase/functions/`](../supabase/functions/) (the ones touched in the P0 pass). The rest are known by name/contract from client usage; they'll be backfilled into the repo as future passes touch them.

- **`record_sale`** ([source](../supabase/functions/record_sale/index.ts)) — `supabase.functions.invoke('record_sale', { body: { item_id, quantity, sale_price, platform, sold_at, source, external_order_id } })`. Inserts the `sales` row, FIFO-depletes `inventory_lots.quantity_remaining`, creates `inventory_movements` rows. Returns `{ sale_id, inventory_status, unfulfilled_quantity }`. **Does not persist `fees`/`shipping_cost`/`net_payout`** — the web client writes those onto the `sales` row in a follow-up `.update()` call (see `recordSale` in mutations.ts). Verified end-to-end in the P0 pass; the source has a contract header comment spelling this out. **Local source ahead of deployed — see Deployment note below** (2026-08-02 fix: the FIFO lot query was missing `deleted_at is null`, so a soft-deleted lot with leftover `quantity_remaining` could still be silently selected as a sale's COGS source).
- **`record_return`** (v21 deployed; local source ahead — see Deployment note below, [source](../supabase/functions/record_return/index.ts)) — called by `ProcessReturnModal` via `recordReturn`. Fixed in the P0 pass: reverses `inventory_movements` LIFO and restores `quantity_remaining` on the original source lots at the lots' original `unit_cost` (no more fake new-lot-at-sale-price), and inserts a `transactions` row for the refund with `amount: -refund_amount`, `schedule_c_category: 'returns_allowances'`, `related_sale_id`, `source: 'manual'`. Also accepts optional `return_shipping_cost`, which inserts a second `transactions` row (`schedule_c_category: 'shipping_postage'`) for the seller's cost of shipping the item back. Both refund-related rows use `type: 'refund'`.
- **`reverse_return`** (not yet deployed — see Deployment note below, [source](../supabase/functions/reverse_return/index.ts)) — called by `ProcessReturnModal`'s edit flow via `reverseReturn`. Re-depletes inventory FIFO for the return's quantity (mirrors `record_sale`'s lot-selection algorithm, including the same 2026-08-02 `deleted_at is null` fix), decrements the sale's `refunded_quantity`/`refunded_amount` and recomputes `return_status`/`inventory_status`, deletes the refund + return-shipping `transactions` rows (`related_sale_id` + `type = 'refund'`), and deletes the `returns` row. Assumes at most one active return per sale (current UI scope). Not atomic — sequential service-role calls, same as `record_return`.
- **`reverse_sale`** (v1, [source](../supabase/functions/reverse_sale/index.ts)) — thin wrapper around the `public.reverse_sale(uuid)` RPC. Invoked by the client's `deleteSale` mutation. Atomically restores depleted lots, deletes `inventory_movements`, deletes linked manual `transactions`, soft-deletes the sale. Errors mapped to 400/403/404/409 (404 = sale not found, 409 = already soft-deleted, replay guard).

### Deployment note

`record_return`'s `return_shipping_cost` param and the new `reverse_return` function exist only as source in this repo as of this change — they have not been deployed (`supabase functions deploy record_return reverse_return`) or exercised against a live/local Supabase stack in this session (no CLI/credentials available here). Deploy and run the Deno e2e tests (`supabase/functions/record_return/index.test.ts`, `supabase/functions/reverse_return/index.test.ts`) against a local stack before relying on this in production.

The `box_openings` migration (`supabase/migrations/20260803120000_box_openings.sql`) and its follow-up `box_openings_source_lot` migration (`supabase/migrations/20260803130000_box_openings_source_lot.sql`, adding `source_lot_id`/`quantity`) have both been applied to the live Supabase project (confirmed live — `shortcut_record_breakdown` writes `source_lot_id = null` successfully as of 2026-08-23).

**2026-08-27: `plaid_exchange_token` v18 needs deploying.** The Fresh-path cleanup now also removes `receipts` storage objects for the transactions it deletes (previously only the rows were deleted, orphaning any attached receipt files in the bucket — see TASKS.md P1 "Start Fresh" item). Fixed in source but **not deployable from this session** (no Supabase CLI/credentials here) — run `supabase functions deploy plaid_exchange_token` before this fix takes effect. Until deployed, a Fresh reconnect on an account with receipts attached still leaves those files in the bucket.

**2026-08-02: `record_sale` also needs redeploying.** Its FIFO lot-selection query never filtered `deleted_at is null`, so a soft-deleted lot (deleting a lot never zeroes `quantity_remaining`) could still be chosen as a sale's COGS source — found live when a deleted lot's wrong `unit_cost` showed up as a brand-new sale's COGS. Fixed in source (both `record_sale` and `reverse_return`) but **not deployable from this session** (no Supabase CLI/credentials here) — run `supabase functions deploy record_sale reverse_return` before this fix takes effect. Until deployed, avoid deleting a lot that still has `quantity_remaining > 0` if any other lot of that item could still be sold from — it remains FIFO-eligible on the live function.
- **`shortcut_record_sale`** ([source](../supabase/functions/shortcut_record_sale/index.ts)) — token-authenticated (service role, no JWT). Looks up `user_id` from `profiles.shortcut_token`, inserts a `sales` row with `source: 'manual'`, `platform: 'manual'`, `item_id: null`, and the provided `item_name`, `quantity`, `sale_price`, `payment_method`, `sold_at: today UTC`, `fees: 0`, `shipping_cost: 0`, `net_payout: sale_price`, `inventory_status: 'ok'`, `return_status: 'none'`. Returns `{ success: true, sale_id }`. Deployed (2026-08-23).
- **`shortcut_record_breakdown`** ([source](../supabase/functions/shortcut_record_breakdown/index.ts)) — token-authenticated (service role, no JWT). Looks up `user_id` from `profiles.shortcut_token`, inserts a `box_openings` row with `box_name: item_name`, `quantity`, `opened_at: today UTC`, `source_lot_id: null`, `box_cost: null`, `allocation_method: null`. Returns `{ success: true, box_opening_id }`. Incomplete breakdowns (source_lot_id IS NULL) surface the ⚠️ banner on the Inventory page. Deployed (2026-08-23).
- **`import_marketplace_csv`** — referenced in TASKS.md as already shared/working server-side (v16); no web UI calls it yet. Not committed in-repo.
- **`plaid_exchange_token`** ([source](../supabase/functions/plaid_exchange_token/index.ts)) — v17 deployed; **v18 local-only, not yet deployed — see Deployment note below**. Called from Settings' Connect Bank / Reconnect flows (see [`docs/features/settings.md`](features/settings.md#bank-connections)). Handles create mode, update mode (reconnect), and the duplicate-connection Keep/Fresh choice.
- **`plaid_sync_transactions`** ([source](../supabase/functions/plaid_sync_transactions/index.ts)) — v33 deployed. Called by Settings' Sync Now / Force Full Resync.
- **`plaid_remove_item`** ([source](../supabase/functions/plaid_remove_item/index.ts)) — called by Settings' Disconnect.
- Other Plaid functions: `plaid_create_link_token`, `plaid_sync_scheduled`, `plaid_oauth_redirect`, `plaid_backfill_*` — not committed in-repo.
- Marketplace OAuth: `marketplace_auth_url`, `marketplace_exchange_token` — referenced in TASKS.md as part of the eBay/Amazon connect flow; no web UI yet.

## Postgres RPCs

- **`public.reverse_sale(p_sale_id uuid) RETURNS json`** ([migration](../supabase/migrations/20260623120000_reverse_sale_rpc.sql)) — `SECURITY DEFINER`, granted to `authenticated`. Locks the sale row, verifies `auth.uid()` matches `sales.user_id`, FOR UPDATE-locks the affected lot rows, restores `quantity_remaining`, deletes movements + linked manual transactions, soft-deletes the sale. Raises `sale_not_found` / `forbidden` / `already_deleted` on edge cases. Called only by the `reverse_sale` edge function; not exposed to the JS client directly.

## Storage

- `receipts` bucket — private, user-scoped RLS, already created for mobile. Web upload UI shipped 2026-08-27 (`ReceiptSection` in the transaction detail slide-over — see [`docs/features/expenses.md`](features/expenses.md#receipt-attachment)). `transactions.receipt_url` stores the storage **path** (`{user_id}/{transaction_id}-{timestamp}.{ext}`), not a public URL — the bucket is private, so viewing requires a signed URL (`getReceiptSignedUrl`, 5 min TTL). This assumes the bucket's RLS policy keys off the first path segment matching `auth.uid()`, the standard Supabase private-bucket pattern; not verified against the actual policy in this pass (no CLI/dashboard access from this session) — confirm before relying on it if uploads start failing with a permission error. `plaid_sync_transactions` already reads `receipt_url` as a path when it `.remove()`s receipts for deleted rows, which is what this assumption is based on.

## Open schema gaps (from TASKS.md, carried over from mobile's architectural review)

- No `quantity` column on `transactions` → CSV multi-unit sales hardcode `quantity: 1`.
- No `sales_tax` column on `sales`/`transactions` → can't prove Line 1 excludes pass-through sales tax.
- RLS on `marketplace_connections.access_token`/`refresh_token` being service-role-only is unconfirmed.
