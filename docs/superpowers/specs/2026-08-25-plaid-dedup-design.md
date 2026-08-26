# Plaid Duplicate Prevention — Design Doc

_Date: 2026-08-25_

## Problem

When a user disconnects and reconnects a bank account through Plaid Link (create mode), Plaid
creates a new `item_id` and issues fresh `plaid_transaction_id`s for all historical transactions.
The existing `onConflict: 'plaid_transaction_id'` guard in `plaid_sync_transactions` cannot
detect these as duplicates — different ID, same real transaction. This caused a mass re-import
(~500+ duplicate rows) after reconnect events in July 2026.

Content-based deduplication (date + amount + merchant) was considered and rejected: resellers
routinely buy the same item from the same vendor for the same price on the same day (up to 20
identical purchases), so a content fingerprint is not a reliable unique signal. It would block
legitimate transactions and create noise in a review UI.

## Core Principle

> **`plaid_transaction_id` is the sole dedup key. Prevention means never letting a situation
> arise where the same real transaction gets two different `plaid_transaction_id`s.**

The entire solution is: stop new Plaid items from being created for accounts that are already
connected. Once that invariant holds, `plaid_transaction_id` dedup works correctly forever.

## Plaid Best Practices Basis

From [Plaid's duplicate items documentation](https://plaid.com/docs/link/duplicate-items/):

- Use the `onSuccess` callback metadata (institution + account masks) to detect duplicates
  **before** exchanging the public token.
- Use Link **update mode** (not create mode) to re-authenticate items in `login_required` state
  — update mode reuses the existing `item_id` and keeps all `plaid_transaction_id`s stable.
- `account_id` in Plaid's API is **stable across reconnects** for the same physical account,
  making it the most reliable duplicate-detection key.

## What We're Building

Three deliverables, plus one schema addition:

| # | Deliverable | Closes |
|---|---|---|
| 1 | `plaid_exchange_token` v17 — pre-exchange duplicate detection | P1: Guard against duplicate connections |
| 2 | `plaid_exchange_token` v17 — update-mode status reset | P1: Reset item status on update-mode reconnect |
| 3 | `SettingsPage` — duplicate connection modal | Client side of the above |
| 4 | `transactions.plaid_account_id` migration + backfill | Enables "Start fresh" deletion + Phase C review UI |

---

## 1. Schema: `transactions.plaid_account_id`

### Migration

```sql
alter table public.transactions
  add column plaid_account_id text;

-- Backfill from already-stored plaid_metadata JSONB (no new Plaid API calls needed)
update public.transactions
  set plaid_account_id = plaid_metadata->>'account_id'
  where source = 'plaid'
    and plaid_metadata is not null
    and plaid_account_id is null;

create index transactions_plaid_account_id_idx
  on public.transactions(plaid_account_id)
  where plaid_account_id is not null;
```

### Usage

- **"Start fresh" deletion**: `DELETE FROM transactions WHERE plaid_account_id = ANY($1)`
  where `$1` is the array of `account_id`s for the accounts being replaced.
- **Phase C review UI**: group orphaned transactions by `plaid_account_id` to surface pairs
  for human review.
- **`buildRow` in `plaid_sync_transactions`**: populate `plaid_account_id: tx.account_id`
  on all new rows going forward.

---

## 2. `plaid_exchange_token` v17

### Detect mode from request

The client sends `mode: 'create' | 'update'` so the edge function knows which path to take.
Update mode is set when the Reconnect button triggers Link (an `item_id` is already known);
create mode is the default for Connect Bank.

```
POST /functions/v1/plaid_exchange_token
{
  "public_token": "public-sandbox-...",
  "metadata": { <Plaid onSuccess metadata> },
  "mode": "create" | "update",
  "item_id": "<existing item_id>"   // update mode only
}
```

### Create mode — pre-exchange duplicate detection

Before calling `itemPublicTokenExchange`:

1. Extract `account_id`s from `metadata.accounts[].id`. These are Plaid's stable account
   identifiers — same physical account always has the same `account_id` even across items.
2. Query `plaid_accounts` for any of those `account_id`s under `user_id`:
   ```sql
   SELECT pa.account_id, pa.mask, pi.item_id, pi.status
   FROM plaid_accounts pa
   JOIN plaid_items pi USING (item_id)
   WHERE pa.account_id = ANY($1) AND pi.user_id = $2
   ```
3. **If no match**: no duplicate — proceed with token exchange as normal (same as v16).
4. **If match found**: return without exchanging:
   ```json
   {
     "status": "duplicate_detected",
     "existing_item_id": "...",
     "existing_institution_name": "Chase",
     "matched_masks": ["••1234", "••5678"],
     "existing_item_status": "active" | "login_required" | "error"
   }
   ```
   The client holds the `public_token` in state and shows the modal.

### Create mode — handling the user's choice

The client sends a second POST to the same endpoint with `choice` added:

```
POST /functions/v1/plaid_exchange_token
{
  "public_token": "public-sandbox-...",   // same token held in client state
  "metadata": { ... },
  "mode": "create",
  "choice": "keep" | "fresh",
  "existing_item_id": "..."
}
```

**"Keep" path:**
- Do not exchange the public token (discard it — 30-min expiry is sufficient window).
- Return the existing item info.
- Client triggers a Sync Now on the existing item.

**"Start fresh" path:**
- Exchange the public token → new `access_token` + `item_id`.
- Hard-delete old transactions for the affected accounts (consistent with existing
  `plaid_sync_transactions` removal behavior — no `deleted_at` soft-delete):
  ```sql
  DELETE FROM transactions
  WHERE plaid_account_id = ANY($matched_account_ids)
    AND user_id = $user_id;
  ```
- Remove old `plaid_accounts` rows (will be re-inserted by new item's account fetch).
- Remove old `plaid_items` row (revoke via `plaidClient.itemRemove` first).
- Insert new `plaid_items` + `plaid_accounts`.
- Client triggers initial sync on new item.

**Edge case — existing item is `login_required` + user chose "Keep":**
Return a warning alongside the keep confirmation:
```json
{
  "status": "kept",
  "warning": "login_required",
  "message": "Your existing connection needs re-authentication. Use the Reconnect button."
}
```
Client shows the warning and surfaces the Reconnect button for that item.

### Update mode — status reset

When `mode: 'update'` and `item_id` provided:

1. Skip duplicate detection entirely.
2. Exchange the public token (confirms re-authentication with Plaid).
3. Write `plaid_items.status = 'active'`, clear `error_message`:
   ```sql
   UPDATE plaid_items
   SET status = 'active', error_message = null
   WHERE item_id = $item_id AND user_id = $user_id;
   ```
4. Return success. Client triggers a Sync Now on the item.

This closes the P1 gap where a successful update-mode reconnect left `status = 'login_required'`
until the next sync ran.

---

## 3. `SettingsPage` client changes

### Sending `mode` on exchange calls

```typescript
// Connect Bank (create mode) — existing usePlaidLink onSuccess
onSuccess: (public_token, metadata) => {
  exchangeTokenMutation.mutate({ public_token, metadata, mode: 'create' })
}

// Reconnect button (update mode) — existing reconnect usePlaidLink
onSuccess: (public_token, _metadata) => {
  exchangeTokenMutation.mutate({ public_token, mode: 'update', item_id: reconnectItemId })
}
```

### Handling `duplicate_detected`

```typescript
const exchangeTokenMutation = useMutation({
  mutationFn: async (payload) => { /* call edge function */ },
  onSuccess: (data, variables) => {
    if (data.status === 'duplicate_detected') {
      setPendingPublicToken(variables.public_token)
      setDuplicateInfo(data)   // institution name, matched masks, existing status
      setShowDuplicateModal(true)
      return
    }
    // normal success path
    queryClient.invalidateQueries(...)
  }
})
```

### `DuplicateConnectionModal`

Shown when `duplicate_detected`. Contains:

- **Header:** "This account is already connected"
- **Body:** "We found an existing {institution_name} connection with accounts ••{masks}.
  What would you like to do?"
- **"Keep existing" button** (primary): sends follow-up call with `choice: 'keep'`, clears
  pending token. If response includes `warning: 'login_required'`, surfaces reconnect prompt.
- **"Start fresh" button** (destructive): confirms "All transactions for these accounts will
  be deleted and re-synced from Plaid." → sends follow-up with `choice: 'fresh'`.
- **Cancel**: dismisses modal, discards pending token.

---

## 4. Existing Data Repair

The reconnect events in July 2026 (AmEx July 25, Chase July 22) already happened and created
orphaned duplicate transactions. `plaid_exchange_token` v17 prevents future floods but cannot
retroactively fix existing ones.

### Step 1 — Run `plaid_account_id` migration (above)

Backfills the column from stored `plaid_metadata`. No new Plaid API calls required.

### Step 2 — Re-sync affected cards

Once `plaid_account_id` is populated, force-resync ••1000, ••1004, ••2003 via
Settings → Force Full Resync. These are the same current items (same `item_id`s), so Plaid
re-delivers the same `plaid_transaction_id`s. The existing `ignoreDuplicates: true` guard skips
existing rows and restores any that were accidentally deleted during the July cleanup.

No content dedup is needed here — same item = same IDs.

### Step 3 — Phase C review UI (separate spec)

The remaining ~441 ambiguous groups (transactions that share content fingerprint but can't be
auto-resolved because repeat purchases are indistinguishable from re-import dupes) go to a
human-review UI. That feature is tracked in TASKS.md P0 and will be specced separately.
The `plaid_account_id` column makes the review UI queries precise.

---

## What Was Considered and Rejected

**Content-level dedup in `plaid_sync_transactions`:**
Rejected. Resellers buy the same item from the same vendor for the same price on the same
day routinely (up to ~20 identical purchases). A `(account_id, date, amount, merchant)` tuple
is not a unique transaction fingerprint. Hard-blocking on content match would silently drop
legitimate transactions; soft-flagging would generate constant noise in the review UI.

**`potential_dupe` flag on transactions:**
Rejected for the same reason — unreliable signal. Deferred to Phase C review UI which uses
human judgment rather than automated content matching.

---

## Files Changed

| File | Change |
|---|---|
| `supabase/migrations/20260825_transactions_plaid_account_id.sql` | New column + backfill + index |
| `supabase/functions/plaid_exchange_token/index.ts` | v17 — duplicate detection + update-mode status reset |
| `src/pages/SettingsPage.tsx` | `mode` param, `duplicate_detected` handling, `DuplicateConnectionModal` |
| `docs/features/settings.md` | Update bank connections + backend dependencies sections |
| `TASKS.md` | Close P1 Plaid items on ship |
