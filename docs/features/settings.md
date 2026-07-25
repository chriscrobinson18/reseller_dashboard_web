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
3. **`plaid_exchange_token` update-mode status reset** — **not implemented.** Reconnecting
   via Link (update mode) never writes `plaid_items.status` back to `'active'`; in practice
   this is masked because the *next* `plaid_sync_transactions` call resets it on success (#2
   above), but there's a window right after a successful reconnect where the badge can still
   read "Reconnect needed" until that next sync runs. Worth fixing directly if that gap ever
   causes confusion.
4. **`plaid_exchange_token` duplicate-connection matching** — fixed 2026-07-25. Matching an
   existing item for the same institution used `.eq('institution_id', id)`, which never
   matches `NULL` — and every item created before institution capture existed has
   `institution_id = NULL`. Reconnecting any pre-existing bank therefore orphaned the old
   item instead of replacing it and created a **duplicate connection** pulling the same
   accounts (this actually happened once, to a real user, before the fix). Now matches on
   `institution_id` OR `institution_name` and sweeps every match, not just one.
