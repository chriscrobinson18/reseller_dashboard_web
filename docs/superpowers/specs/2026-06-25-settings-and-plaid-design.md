---
name: settings-and-plaid
description: Settings page (web's first) with stacked Bank Connections + Custom Categories sections. Brings Plaid Link for Web online: connect, sync, force-resync, reconnect (update mode), per-account toggles, disconnect. Reuses already-shipped custom-categories UI inline. Adds a small `plaid_items.status` migration to drive the "Reconnect needed" badge.
status: design
created: 2026-06-25
authors:
  - Chris (with Claude)
---

# Settings Page + Plaid Link for Web — Design

## Goal

Ship the web client's first Settings page and bring Plaid Link online. Today, web has no Settings route and zero Plaid wiring — but the backend already supports Plaid end-to-end (3 production `plaid_items`, 21 `plaid_accounts`, and edge functions `plaid_create_link_token` / `plaid_exchange_token` / `plaid_sync_transactions` / `plaid_remove_item`). The work is purely a web client UI build plus one small schema column to surface connection status.

## Non-goals

- CSV import UI, Settlements UI, Receipts, Returns UI, Marketplace OAuth, Tax settings, Export. Those are separate P1 specs.
- Background webhooks (P3). v1 relies on manual "Sync Now" and the existing scheduled cron.
- New edge functions. v1 piggybacks on existing functions, with one backend dependency: `plaid_sync_transactions` must accept a `reset_cursor: true` flag (see §6).

## Scope summary

| Decision | Choice |
|---|---|
| Settings sections in v1 | Bank Connections + Custom Categories (reuses already-shipped UI inline) |
| Nav placement | 5th item in `Layout.tsx` `NAV` array (gear icon) |
| Page layout | Single `/settings` route, two stacked sections, no sub-routes |
| Disconnect behavior | Keep historical transactions; remove `plaid_items` row |
| Sync controls | Sync Now **and** Force Full Resync (cursor reset) |
| Reconnect handling | Status badge + "Reconnect" button using Plaid Link **update mode** |
| Plaid Link wiring | Inline `usePlaidLink` hook in `SettingsPage.tsx` (Approach A) |

## Architecture

### Routing & nav

- New route `/settings` in `src/App.tsx` alongside the existing four.
- New nav entry in `src/components/Layout.tsx` `NAV` array:
  ```ts
  { to: '/settings', icon: Settings, label: 'Settings' }
  ```
  Using the lucide-react `Settings` gear icon. Same styling as the other entries.

### Page shell

- New file `src/pages/SettingsPage.tsx`.
- Header: "Settings" title + subtitle "Manage bank connections and custom categories".
- Body: two stacked `<section>` containers with vertical spacing. No tabs, no period picker (Settings is period-agnostic).

```
Settings
  Manage bank connections and custom categories
  ────────────────────────────────────────────
  [ Bank Connections section ]
  [ Custom Categories section ]
```

### Data hooks

Added to `src/lib/queries.ts`:

- `usePlaidItems()` — `select * from plaid_items where deleted_at is null order by institution_name nulls last`. (`deleted_at` filter only applies if mobile uses soft-delete — confirmed nullable in schema; v1 keeps the filter as a forward-compat hedge even though our disconnect path hard-deletes.)
- `usePlaidAccounts(itemId)` — `select * from plaid_accounts where item_id = ? order by name`. One query per item (not one big join) — accounts list is rendered inline under each item card.

Added to `src/lib/mutations.ts`:

- `usePlaidCreateLinkToken()` — `supabase.functions.invoke('plaid_create_link_token', { body: { item_id?: string } })`. When `item_id` is provided, backend returns an update-mode token; otherwise a create-mode token.
- `usePlaidExchangeToken()` — `supabase.functions.invoke('plaid_exchange_token', { body: { public_token, metadata } })`. Invalidates `plaid_items` + `plaid_accounts`.
- `usePlaidSyncTransactions()` — `supabase.functions.invoke('plaid_sync_transactions', { body: { item_id, reset_cursor?: boolean } })`. Invalidates `plaid_items`, `plaid_accounts`, `transactions`.
- `usePlaidRemoveItem()` — `supabase.functions.invoke('plaid_remove_item', { body: { item_id } })`. Invalidates `plaid_items`.
- `useUpdatePlaidAccount({ id, display_name?, sync_enabled? })` — direct table update via `supabase.from('plaid_accounts').update(...).eq('id', id)`. RLS scopes by `user_id`.

## Bank Connections section

### Section header

Title "Bank Connections", count badge `({plaid_items.length})`, primary "Connect Bank" button (top-right). Clicking "Connect Bank" triggers the create-mode Plaid Link flow (§5).

### Item card

One card per `plaid_item`, stacked vertically. Each card contains:

- **Header row**:
  - Institution name (bold) — from `plaid_items.institution_name`.
  - Last sync time (gray) — relative ("Synced 2h ago") via a small helper. Computed from `plaid_items.last_synced_at`.
  - Status badge (right side) — see §4.
- **Action row** (right-aligned):
  - "Sync Now" primary button.
  - Kebab menu containing: "Force Full Resync", "Reconnect" (only when `status = 'login_required'`), "Disconnect" (destructive, red).
- **Accounts list** (below the header rows, indented):
  - One row per `plaid_account`: editable display_name with inline pencil → input on click, mask (`•• 1234`), subtype pill (e.g. "Checking"), `sync_enabled` toggle (right-aligned).

### Empty state (no items)

Centered: "Connect your first bank to start auto-importing transactions" + a single "Connect Bank" button. Same `usePlaidLink` flow as the header button.

### Loading & error

- `usePlaidItems().isPending` → skeleton: 2 placeholder cards.
- `usePlaidItems().isError` → red banner "Couldn't load bank connections" with retry.

## Status badge

Driven by a small client helper `getItemStatus(item, syncMutationState)`:

| Badge | Color | When |
|---|---|---|
| Connected | green | `item.status === 'active'` and not syncing |
| Syncing… | yellow | the `usePlaidSyncTransactions` mutation is in flight for this `item_id` |
| Reconnect needed | red | `item.status === 'login_required'` |
| Error | red | `item.status === 'error'` (shown with hover tooltip = `item.error_message`) |

The `status`/`error_message` columns require a small migration (§7). The web UI degrades gracefully if the columns are missing — treat as `'active'`.

## Plaid Link flow (Approach A)

`SettingsPage.tsx` owns a single `usePlaidLink({ token, onSuccess, onExit })` instance plus local state:

```ts
const [linkToken, setLinkToken] = useState<string | null>(null)
const [linkMode, setLinkMode] = useState<'create' | 'update'>('create')
const [updateItemId, setUpdateItemId] = useState<string | undefined>()

const createLinkToken = usePlaidCreateLinkToken()
const exchangeToken = usePlaidExchangeToken()

const { open, ready } = usePlaidLink({
  token: linkToken,
  onSuccess: (public_token, metadata) => {
    exchangeToken.mutate({ public_token, metadata })
    setLinkToken(null)
  },
  onExit: (err) => {
    if (err) setLinkError('Plaid Link closed with an error.')
    setLinkToken(null)
  },
})

useEffect(() => {
  if (linkToken && ready) open()
}, [linkToken, ready, open])
```

### Create flow

1. User clicks "Connect Bank".
2. `setLinkMode('create')`, `setUpdateItemId(undefined)`, `createLinkToken.mutate(undefined, { onSuccess: ({ link_token }) => setLinkToken(link_token) })`.
3. `usePlaidLink` becomes `ready`, effect runs, `open()` launches Plaid Link.
4. User completes flow → `onSuccess` → `exchangeToken.mutate({ public_token, metadata })`.
5. On exchange success → inline confirmation "Connected to {institution}" → React Query invalidations refresh the list.

### Update (reconnect) flow

1. User clicks "Reconnect" on a stale card.
2. `setLinkMode('update')`, `setUpdateItemId(item.item_id)`, `createLinkToken.mutate({ item_id: item.item_id })`.
3. Same open → `onSuccess` flow. The backend MUST flip `plaid_items.status` back to `'active'` after a successful update-mode exchange (this is part of the backend dependency).

### Env config

A new `VITE_PLAID_ENV` (`sandbox` | `production`) is read for cosmetic purposes only — shown as a footer pill on Settings (`"Plaid env: sandbox"`) when not `production`. The actual Plaid environment is owned server-side by the edge function. No client `client_id`/`secret`.

## Notification convention

This project does not use a toast library — existing mutations surface success/error inline (e.g. `TransactionInventorySection`, `EditLotModal`: `mutation.isError && <div className="text-xs text-red-600">{(error as Error).message}</div>`). Settings follows the same pattern:

- **Errors** — small red text under the affected card or section header.
- **Success** — short-lived inline confirmation (e.g. swap the "Sync Now" button label to "✓ Synced" for ~2s, or a small green helper line "Synced 12 new transactions" that auto-dismisses after ~4s using local state). No global toast component is introduced.

## Sync controls

### Sync Now (per item)

- Button calls `usePlaidSyncTransactions().mutate({ item_id })`.
- Mutation state tracked by `item_id` (use mutation key `['plaidSync', item_id]`) so the right card shows "Syncing…".
- On success: inline confirmation under the action row — `"Synced {N} new transactions from {institution}"` (N from the function's response payload, falling back to "Sync complete" if absent). Auto-dismiss after ~4s via local state.
- On error: inline red error text under the action row; badge returns to persisted status.

### Force Full Resync

- Kebab → "Force Full Resync" → `<ConfirmDialog />` with body: "Re-import all transactions from {institution}? This may take up to a minute and will pull historical data again."
- On confirm: `mutate({ item_id, reset_cursor: true })`.
- Same inline confirmation pattern as Sync Now.

**Backend dependency** ⚠️ — `plaid_sync_transactions` must accept `reset_cursor: true` and clear `plaid_items.cursor`/`plaid_items.transactions_cursor` before pulling. The function source is not in-repo; this is a backend coordination item that must land alongside this UI. If the flag is ignored, "Force Full Resync" reduces to "Sync Now" — degraded but not broken.

## Disconnect flow

- Kebab → "Disconnect" → `<ConfirmDialog />` body: "Disconnect {institution}? Future syncs will stop. Past transactions will remain on your Expenses page and continue to count for Schedule C."
- On confirm: `useRemoveItem.mutate({ item_id })`.
- Backend deletes `plaid_items` + cascades `plaid_accounts`. Existing transactions retain `source = 'plaid'` and existing `account_display` text, so their badges still render correctly on Expenses.

## Per-account controls

- **Display name edit** — inline pencil icon. Click → input with save / cancel. Saves via `useUpdatePlaidAccount({ id, display_name })`. Empty string → revert to `name`.
- **`sync_enabled` toggle** — small switch in each account row. Direct update of `sync_enabled` column. Disabled accounts: transactions stop syncing on next pull (backend already respects the flag per mobile precedent — verify in manual test #5).

## Schema migration

`supabase/migrations/<timestamp>_plaid_item_status.sql` (or applied via `mcp__supabase__apply_migration`):

```sql
alter table public.plaid_items
  add column status text not null default 'active'
    check (status in ('active', 'login_required', 'error')),
  add column error_message text;

comment on column public.plaid_items.status is
  'Connection health: active = normal, login_required = needs Plaid Link update mode, error = generic failure.';
```

- Web reads `status` to drive the badge and the "Reconnect" button visibility.
- Backend writes `status = 'login_required'` when `plaid_sync_transactions` gets `ITEM_LOGIN_REQUIRED` from Plaid, and flips back to `'active'` after a successful update-mode exchange.
- Forward-compat: if columns are missing at runtime, the client treats `status` as `'active'` (graceful degrade).

This is a **backend coordination item** — both the migration and the edge-function writes must land alongside this UI. Without them, the "Reconnect needed" badge never appears; sync still works.

## Custom Categories section

- Header row: "Custom Categories" + count badge + "Add Category" button.
- Content: reuses the **body** of the already-shipped `ManageCategoriesModal`, extracted into a new `<CustomCategoriesList />` component so both the modal (still used from in-context category dropdowns app-wide) and the Settings section render the same list/edit/delete UI.
- No new business logic: same `useCustomCategories()` query, same add/edit/soft-delete mutations.
- Empty state: "No custom categories yet — add one to extend the Schedule C breakdown."

### Refactor scope for this extraction

- Move the list + add-form JSX out of `ManageCategoriesModal` into `CustomCategoriesList`.
- `ManageCategoriesModal` becomes a thin shell: `<Modal>...<CustomCategoriesList /></Modal>`.
- Verify zero behavior change: existing in-context dropdown "Manage Categories" entry still opens the modal and works identically.

## Error handling & edge cases

| Case | Behavior |
|---|---|
| Link token fetch fails | Inline "Couldn't connect to Plaid. Try again." Clear linkToken. |
| User exits Plaid Link without finishing | Silent; clear linkToken. |
| Exchange fails after onSuccess | Inline error; user retries "Connect Bank" (public_token is single-use, so Plaid issues a new one). |
| Sync rate-limited (HTTP 429) | Inline "Sync in progress, try again in a minute." |
| `reset_cursor` ignored by backend | Force Full Resync silently reduces to Sync Now. Documented; manual test catches this. |
| `plaid_items.status` columns missing | Client treats all items as `status = 'active'`; "Reconnect needed" badge never appears. |
| First-load race (`usePlaidItems` pending) | Skeleton rows, not empty state. |

## Testing strategy

### Unit

Nothing money-math here. Existing vitest setup doesn't need new specs unless the relative-time helper or `getItemStatus` helper grows logic worth testing. Per CLAUDE.md: "Add tests when you touch covered files; don't add brand-new test files for uncovered areas unless explicitly asked." Skip unit tests for v1.

### Manual test plan

1. **Empty state → Connect** — Empty Plaid Link in sandbox with creds `user_good` / `pass_good`. First item appears, accounts list populated.
2. **Two items** — Add second institution. Both visible, sorted by `institution_name`.
3. **Sync Now** — On each item; inline confirmation shows correct N; `last_synced_at` updates.
4. **Force Full Resync** — Confirm dialog → completes within ~60s. `cursor` cleared server-side (verify via SQL).
5. **Per-account `sync_enabled` off** — Toggle one account off → next Sync Now skips that account (verified by transactions count delta).
6. **Display name edit** — Edit one account; reload page; name persists.
7. **Disconnect** — ConfirmDialog → item card gone → existing transactions retained on Expenses, source = 'plaid' badge still shows, `account_display` still readable.
8. **ITEM_LOGIN_REQUIRED** — Force in sandbox (`/sandbox/item/reset_login`) → next Sync Now flips badge to red "Reconnect needed" → Reconnect button launches update mode → fresh sync succeeds, badge returns to green.
9. **Custom Categories parity** — From Settings, add a category; verify it appears in the category dropdown on Expenses (and vice versa). Modal entry point from a dropdown still works.

### CI gates

- `npm run build` (= `tsc -b && vite build`) must pass.
- `npm run lint` must pass.

## Open backend coordination items

These are the only items that touch surfaces outside the web client. They are NOT in the web v1 PR scope but MUST land in parallel for the UI to be fully functional:

1. **`plaid_sync_transactions`** — accept `{ item_id, reset_cursor?: boolean }`; clear `cursor` when `reset_cursor === true`. (Required for Force Full Resync; degrades gracefully if missing.)
2. **`plaid_sync_transactions`** — on `ITEM_LOGIN_REQUIRED` error from Plaid, set `plaid_items.status = 'login_required'` and `error_message = <plaid_error.message>`. (Required for Reconnect badge; degrades gracefully if missing.)
3. **`plaid_exchange_token`** — when called with an existing `item_id` (update mode), flip `plaid_items.status = 'active'` and clear `error_message` on success. (Required for Reconnect flow completion; degrades gracefully — user can manually re-sync.)
4. **`plaid_items.status` + `error_message` columns** — migration above.

Flag these to whoever owns the edge functions before merging the UI PR.

## Files touched

```
src/App.tsx                                       # new /settings route
src/components/Layout.tsx                         # add Settings to NAV
src/components/CustomCategoriesList.tsx           # NEW — extracted from ManageCategoriesModal
src/components/modals/ManageCategoriesModal.tsx   # slim down to <Modal><CustomCategoriesList /></Modal>
src/pages/SettingsPage.tsx                        # NEW — main page
src/lib/queries.ts                                # add usePlaidItems, usePlaidAccounts
src/lib/mutations.ts                              # add Plaid mutations + useUpdatePlaidAccount
src/lib/types.ts                                  # add PlaidItem, PlaidAccount types incl. status
package.json                                      # add react-plaid-link
.env.example                                      # document VITE_PLAID_ENV
docs/features/                                    # NEW settings.md (per CLAUDE.md doc rule)
docs/supabase-schema.md                           # document new plaid_items columns
supabase/migrations/<ts>_plaid_item_status.sql    # NEW migration
```

## Out of scope (future)

- Plaid webhooks (P3) — would replace the manual Sync Now with push-driven updates.
- Multi-account institution edit/rename batch UI — v1 edits accounts one at a time.
- Per-institution sync schedule — v1 uses the existing global cron + manual sync.
- Settings sub-routes — defer until a 3rd section ships and the page becomes too tall.
