# Settings page

Path: `/settings` → [src/pages/SettingsPage.tsx](../../src/pages/SettingsPage.tsx)

The Settings page hosts cross-cutting account configuration. v1 has two sections, stacked
vertically on a single scrollable page.

## Bank Connections

Lists every connected Plaid institution from `plaid_items`, with the accounts under each
institution from `plaid_accounts`.

- **Connect Bank** — launches Plaid Link in create mode. On success the
  `plaid_exchange_token` edge function persists a new `plaid_items` row + its
  `plaid_accounts`. React Query invalidations refresh the list.
- **Duplicate detection** — if the accounts being connected share a Plaid `account_id`
  with an existing connection, the exchange is paused and the user is prompted to
  **Keep existing transactions** (existing connection preserved, a sync is triggered)
  or **Start fresh** (old transactions deleted, new item created). Implemented in
  `plaid_exchange_token` v17. See `docs/superpowers/specs/2026-08-25-plaid-dedup-design.md`.
  **Start fresh** now also cleans up any `receipts` storage objects attached to the
  deleted transactions (v18, 2026-08-27) — previously only the `transactions` rows were
  removed, orphaning receipt files in the bucket. Mirrors the same cleanup
  `plaid_sync_transactions` already does for its removed-transaction path. **Not yet
  deployed** — see the Deployment note in `docs/supabase-schema.md`.
- **Sync Now** — per-item button calling `plaid_sync_transactions`. On success, surfaces
  an inline count of newly-added transactions (`transactions_added` — the response has
  never actually had an `inserted` field; that was a client-side type bug, fixed
  2026-07-24, that made the count silently show as "Sync complete" with no number every
  time). If the response carries `warnings` — meaning this *item* failed even though the
  HTTP call succeeded — an amber warning line replaces the success line instead. A 200
  response is not proof this connection actually synced; check `warnings`.
- **Force Full Resync** — kebab menu → confirm dialog → `plaid_sync_transactions` with
  `reset_cursor: true`. Backend dependency: the edge function must accept the flag and
  clear `plaid_items.cursor`. If the flag is ignored, this silently degrades to a normal
  Sync Now.
  - After the `plaid_metadata_capture` migration (2026-06-26), running Force Full Resync once per institution backfills merchant logos, locations, payment channel, and detailed PFC onto historical transactions. User edits (categories, notes, sale links, receipts) are not touched.
- **Reconnect** — appears as a red button when `plaid_items.status = 'login_required'`.
  Launches Plaid Link in update mode (passes `item_id` to `plaid_create_link_token`).
  - On successful reconnect, `plaid_exchange_token` v17 resets `plaid_items.status = 'active'`
    immediately — the badge clears without waiting for the next sync.
- **Disconnect** — kebab menu → confirm dialog → `plaid_remove_item`. Historical
  transactions are retained with `source = 'plaid'`; the `account_display` column on
  each transaction keeps the institution + mask readable on the Expenses page.

### Per-account controls

Each `plaid_account` row supports:
- Inline rename (`display_name` column), pencil icon → input.
- `sync_enabled` checkbox — direct table update. Backend is expected to honor this on
  the next sync.

### Status badge

Driven by [`itemStatus.ts`](../../src/pages/settings/itemStatus.ts):

| Badge | When |
|---|---|
| Connected (green) | `status = 'active'`, no sync in flight, and last sync is recent |
| Syncing… (amber) | `plaidSyncTransactions` mutation in flight for this `item_id` |
| Reconnect needed (red) | `status = 'login_required'` — Plaid returned a re-auth-class error (see below) |
| Error (red) | `status = 'error'` — any other Plaid error; tooltip shows `error_message` |
| Not syncing (amber) | `status = 'active'` but `last_synced_at` is ≥ `STALE_AFTER_DAYS` (7) old |

If the `status` column is absent (migration not applied), the helper treats it as
`'active'` so the UI degrades gracefully.

**"Not syncing" is deliberately symptom-based, not error-based.** It keys off how long
it's been since a successful sync rather than any Plaid error code, so it catches failure
modes the code-mapping below doesn't classify. It's what actually caught the incident this
was built for: an AmEx connection went `ITEM_LOGIN_REQUIRED` and — before the fix
below — the error was logged server-side only and never written to `status`, so the badge
stayed green for 113 days while ~4 months of transactions silently stopped syncing. The
stale check would have shown "Not syncing" within a week regardless of whether the error
handling below existed at all.

**Error-code mapping** (`plaid_sync_transactions` v33, 2026-07-24): every Plaid error
except `PRODUCT_NOT_READY` now writes `status`/`error_message` and returns a warning,
where previously only `PRODUCT_NOT_READY` was handled and everything else was
`console.error`-only while the response still said `success: true`. Codes mapped to
`login_required` (i.e. "Reconnect needed", not just "Error"): `ITEM_LOGIN_REQUIRED`,
`PENDING_EXPIRATION`, `USER_PERMISSION_REVOKED`, `USER_INPUT_TIMEOUT`, `ITEM_LOCKED`.
Everything else maps to `error`. A clean sync resets `status` to `'active'` and clears
`error_message`, so a reconnected item stops nagging on its next successful sync.

## Apple Shortcuts

Renders [`ShortcutsSettingsCard`](../../src/components/ShortcutsSettingsCard.tsx).

Lets users record quick sales and inventory breakdowns from iPhone via the **Log Sale** Apple Shortcut (`public/reseller-sale.shortcut`).

### States

**No token generated:**
- "Generate Token" button — calls `crypto.randomUUID()` client-side, upserts the UUID to `profiles.shortcut_token`.

**Token exists:**
- UUID shown in full + **Copy** button (copies to clipboard, briefly shows "Copied!").
- **Add to Shortcuts** — `<a href="/reseller-sale.shortcut" download>` link; downloads the pre-built shortcut file. On first run the shortcut prompts for the token (Import Question).
- **Regenerate** — `ConfirmDialog` → new UUID via `crypto.randomUUID()`. Immediately invalidates the old token; the Shortcut will prompt for a new one on next run.

### Auth model

`profiles.shortcut_token` (uuid, unique, nullable). The two edge functions `shortcut_record_sale` and `shortcut_record_breakdown` authenticate by this token only — no JWT required in the Shortcut itself. Regenerating or clearing the token locks out any previously distributed Shortcut immediately.

### Shortcut file

`public/reseller-sale.shortcut` is a signed binary plist generated by `scripts/generate_shortcut.py` (run `python3 scripts/generate_shortcut.py` to regenerate after structural changes). It must be re-signed with `shortcuts sign --mode anyone` to install on any iPhone — the script does this automatically via the macOS `shortcuts` CLI.

## Custom Categories

Renders [`CustomCategoriesList`](../../src/components/CustomCategoriesList.tsx) — the same
component used by `ManageCategoriesModal`. The list view is identical to the modal except
the "Done" button is omitted (no modal to dismiss). See
[`docs/superpowers/specs/2026-06-25-custom-categories-design.md`](../superpowers/specs/2026-06-25-custom-categories-design.md)
for the underlying category model.

## Backend dependencies

Current state of what this page depends on, not a forward-looking wishlist — items below
that used to be listed as pending are now shipped:

1. **`plaid_items.status` + `error_message` columns** — migration `plaid_item_status`. ✅ Live.
2. **`plaid_sync_transactions`** — accepts `{ item_id, reset_cursor?: boolean }`; when
   `reset_cursor = true`, clears `cursor` before pulling (Force Full Resync). ✅ Live, and as
   of v33 (2026-07-24) also writes `status`/`error_message` on any Plaid error, not just
   `ITEM_LOGIN_REQUIRED` — see the status-badge section above for the full code mapping and
   why the response is `success: true` even when an item failed.
3. **`plaid_exchange_token` update-mode status reset** — ✅ Resolved in v17. Reconnecting
   via Link (update mode) now writes `plaid_items.status = 'active'` immediately on success;
   the "Reconnect needed" badge clears without waiting for the next sync.
4. **`plaid_exchange_token` duplicate-connection matching** — fixed 2026-07-25. Matching an
   existing item for the same institution used `.eq('institution_id', id)`, which never
   matches `NULL` — and every item created before institution capture existed has
   `institution_id = NULL`. Reconnecting any pre-existing bank therefore orphaned the old
   item instead of replacing it and created a **duplicate connection** pulling the same
   accounts (this actually happened once, to a real user, before the fix). Now matches on
   `institution_id` OR `institution_name` and sweeps every match, not just one.

## Marketplace CSV Import

A "Marketplace CSV Import" section (after Custom Categories) has three platform cards — eBay, Amazon, Mercari — each with an "Import CSV" button. Selecting a `.csv` file triggers a two-step flow:

1. **`import_marketplace_csv` edge function (v16)** — parses the CSV and upserts rows into `transactions` with `source='csv_import'`, `platform=<platform>`, and `csv_group_id` linking rows that belong to the same settlement period
2. **`sync_csv_orders_to_sales` edge function (v1)** — groups those transactions by order ref (`notes` field) and upserts `sales` rows with `source='ebay'|'amazon'|'csv_import'`, `external_order_id=<orderRef>`, `item_id=null` (unlinked)

A result banner shows rows imported and sales created/updated.

## Settlement Status

A "Settlement Status" section (after CSV Import) shows eBay and Amazon settlement groups only (Mercari has no disbursement structure). Each group is a `csv_group_id` bucket containing one settlement period's transactions. Groups display:

- **✓ Matched** — linked to a Plaid bank deposit via `parent_settlement_id`
- **Needs Match** — has an expected bank deposit amount (`transfer` row present); tap "Find Plaid Match" in the detail view to search and link
- **On Hold** — eBay/Amazon held funds in reserve; balance carries forward; no action needed

Clicking a group opens `CSVGroupDetailSlideOver` which shows the group summary, bank match UI, transaction list, and payout row.

### Settlement linking flow

1. "Find Plaid Match" searches `transactions` where `source='plaid'` and `amount = expectedDeposit` within the group date range + 14 days. Falls back to ±$5.00 near-match.
2. Selecting a candidate:
   - If near-match: inserts a manual `commissions_fees` transaction for the gap amount
   - Sets `record_type='settlement'`, `schedule_c_category='settlement'`, `platform=<platform>` on the Plaid row (`markTransactionAsSettlement`)
   - Sets `parent_settlement_id=<plaid_tx_id>` on all CSV rows in the group (`linkCSVGroupToSettlement`)
3. "Remove Match" clears `parent_settlement_id` on all CSV rows in the group (`unlinkCSVGroup`)

## Return Reconciliation

_Added 2026-08-27 — see [`docs/superpowers/specs/2026-08-27-csv-return-reconciliation-design.md`](../superpowers/specs/2026-08-27-csv-return-reconciliation-design.md). **⚠️ Not deployed** — see the Deployment note in `docs/supabase-schema.md` before relying on this; the live edge function will double-deduct a refund if used before the migration + `record_return`/`reverse_return` v2 are deployed._

A "Return Reconciliation" section (below Settlement Status) detects refund +
return-shipping rows already sitting in imported `csv_import` transactions
that belong to an **inventory-linked** sale (recorded via `RecordSaleModal`,
not the unlinked synthetic sales `sync_csv_orders_to_sales` creates) but
haven't been routed through `record_return` — so the lot was never restored
and the refund isn't showing as a distinct Returns & Allowances line.

- Same segmented eBay/Amazon toggle as Settlement Status. `useCSVReturnCandidates(platform)`
  (`src/lib/csvReturns.ts`) groups unlinked `csv_import` rows by order ref
  (`notes`), finds a negative `'payout'`-categorized row (the refund) plus a
  best-guess `'shipping_postage'` row dated on/after it (the return label —
  no platform reliably marks return vs. outbound labels in this app's import
  categories), and matches to a sale by `external_order_id`.
- Each row shows a status badge: **Review** (exactly one matching sale),
  **N sales match** (ambiguous — the modal offers a picker), or **Unmatched**
  (no inventory-linked sale found for that order — inert, nothing to apply to).
- Clicking a row opens `ReconcileReturnModal` — same fields as the manual
  `ProcessReturnModal` (quantity, refund amount, reason), plus a checkbox to
  include/exclude the guessed return-shipping row. "Apply Return" calls
  `recordReturn({ ..., refundTransactionId, returnShippingTransactionId, source: 'csv_import' })`
  — `record_return` re-tags those existing rows (sets `related_sale_id` +,
  for the refund row, `schedule_c_category: 'returns_allowances'`) instead of
  inserting duplicates.
- Purely a review queue — nothing mutates until "Apply Return" is clicked. No
  auto-apply, no persistent per-candidate dismiss (re-categorizing the
  underlying row in Expenses is the escape hatch for a false positive), no
  manual sale picker for the unmatched case. See the design doc's "Deliberately
  out of scope" section.
