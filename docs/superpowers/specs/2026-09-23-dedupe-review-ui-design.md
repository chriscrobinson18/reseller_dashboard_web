---
name: plaid-orphan-dedup
description: One-time dedup by comparing DB transactions against Plaid's canonical transaction list
status: design
created: 2026-09-23
authors:
  - User (with Claude)
---

# Plaid Orphan Transaction Dedup

## Goal

Definitively identify and delete duplicate Plaid-sourced transactions by pulling the canonical transaction list from Plaid's API and deleting any DB rows whose `plaid_transaction_id` doesn't exist in Plaid's response. No human judgment needed — if Plaid doesn't know about it, it's an artifact from an old/revoked connection.

## Background

A July 2026 AmEx reconnect re-imported ~4 months of history under a new Plaid item ID, creating ~441 duplicate groups (~734 extra rows). The root cause is fixed (`plaid_exchange_token` v17), but the orphaned rows remain. Content-based dedup was rejected because resellers make 20+ identical purchases same-card same-day. This approach sidesteps the ambiguity entirely — Plaid's canonical `transaction_id` set is the source of truth.

## How It Works

1. **Edge function `find_plaid_orphans`** — for each active `plaid_items` row for this user:
   - Call Plaid `/transactions/get` with a 2-year window, paginating to collect ALL `transaction_id`s
   - Query DB for `source = 'plaid'` rows on the same `plaid_account_id`s
   - Return rows whose `plaid_transaction_id` is NOT in Plaid's canonical set

2. **Client** — Settings > Banks tab, "Find Duplicate Transactions" button:
   - Calls the edge function, shows results: "Found N orphaned transactions"
   - Expandable list of orphaned rows (date, amount, merchant, account)
   - "Delete All" with confirmation dialog → hard-deletes

3. **No migration needed** — uses existing columns (`plaid_transaction_id`, `plaid_account_id`, `source`)

## Edge Function: `find_plaid_orphans`

```
POST /find_plaid_orphans
Auth: Bearer <user JWT>

Response: {
  orphans: Array<{
    id: string
    date: string
    amount: number
    merchant: string
    account_display: string
    plaid_transaction_id: string
    schedule_c_category: string | null
    notes: string | null
    receipt_url: string | null
  }>
  scanned_accounts: number
  total_plaid_transactions: number
}
```

**Logic:**
1. Get all active `plaid_items` for the user (join to `plaid_accounts` for account IDs)
2. For each item, call `/transactions/get` with `start_date` = 2 years ago, `end_date` = today, paginate (500/page)
3. Collect all `transaction_id`s into a Set
4. Query `transactions` where `source = 'plaid'` and `plaid_transaction_id IS NOT NULL`
5. Filter to rows whose `plaid_transaction_id` is not in the Set
6. Return the orphaned rows

**Edge cases:**
- Items with `status != 'active'` are skipped (can't call Plaid API on broken connections)
- If a Plaid API call fails for one item, include a warning but continue with other items
- Transactions older than Plaid's history window won't be flagged (acceptable — the known dupes are recent)

## UI

Simple inline section in the Banks tab (not a new tab — this is a one-time cleanup tool):

- "Find Duplicate Transactions" button
- Loading state while scanning
- Results: count + expandable transaction list
- "Delete All N Orphaned Transactions" button with ConfirmDialog
- Success state: "Cleaned up N duplicate transactions"
- Empty state: "No duplicates found"

## Files Changed

| File | Change |
|------|--------|
| `supabase/functions/find_plaid_orphans/index.ts` | New edge function |
| `src/lib/mutations.ts` | `findPlaidOrphans()` call + `deleteDuplicateTransactions(ids)` |
| `src/pages/SettingsPage.tsx` | "Find Duplicates" button + results UI in Banks tab |

## What Was Considered and Rejected

- **Content-based grouping UI (original design):** Required human judgment for every group because identical purchases are legitimate. The Plaid canonical comparison eliminates ambiguity entirely.
- **Stored review queue / duplicate_status column:** Over-engineered for a deterministic set-difference.
- **Full Settings tab for duplicates:** Overkill for a one-time operation. A button in the Banks tab is sufficient.
- **Resetting the Plaid sync cursor:** Would modify state; `/transactions/get` is read-only.
