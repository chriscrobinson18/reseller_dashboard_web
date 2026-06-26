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
- **Sync Now** — per-item button calling `plaid_sync_transactions`. Surfaces an inline
  success line with the count of newly-inserted transactions when the function returns one.
- **Force Full Resync** — kebab menu → confirm dialog → `plaid_sync_transactions` with
  `reset_cursor: true`. Backend dependency: the edge function must accept the flag and
  clear `plaid_items.cursor`. If the flag is ignored, this silently degrades to a normal
  Sync Now.
  - After the `plaid_metadata_capture` migration (2026-06-26), running Force Full Resync once per institution backfills merchant logos, locations, payment channel, and detailed PFC onto historical transactions. User edits (categories, notes, sale links, receipts) are not touched.
- **Reconnect** — appears as a red button when `plaid_items.status = 'login_required'`.
  Launches Plaid Link in update mode (passes `item_id` to `plaid_create_link_token`).
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
| Connected (green) | `status = 'active'` and no sync in flight |
| Syncing… (amber) | `plaidSyncTransactions` mutation in flight for this `item_id` |
| Reconnect needed (red) | `status = 'login_required'` — Plaid returned `ITEM_LOGIN_REQUIRED` |
| Error (red) | `status = 'error'` — tooltip shows `error_message` |

If the `status` column is absent (migration not applied), the helper treats it as
`'active'` so the UI degrades gracefully.

## Custom Categories

Renders [`CustomCategoriesList`](../../src/components/CustomCategoriesList.tsx) — the same
component used by `ManageCategoriesModal`. The list view is identical to the modal except
the "Done" button is omitted (no modal to dismiss). See
[`docs/superpowers/specs/2026-06-25-custom-categories-design.md`](../superpowers/specs/2026-06-25-custom-categories-design.md)
for the underlying category model.

## Backend dependencies

The following edge function / schema changes must land in parallel with this page for
full functionality (page works without them, degrading gracefully):

1. `plaid_items.status` + `error_message` columns — migration `plaid_item_status`.
2. `plaid_sync_transactions` — accept `{ item_id, reset_cursor?: boolean }`; when
   `reset_cursor = true`, clear `cursor` before pulling. Set `plaid_items.status =
   'login_required'` + `error_message` on `ITEM_LOGIN_REQUIRED`.
3. `plaid_exchange_token` — when called for update mode (existing `item_id`), reset
   `plaid_items.status = 'active'` and clear `error_message` on success.
