# Merchant Auto-Categorization Rules — Design

_2026-09-23 · P1 feature · web-first, shared schema_

---

## Overview

Users repeatedly assign the same Schedule C category to the same merchant (e.g. every USPS charge → Shipping & Postage, every Whatnot payout → Payout/Income). Today that's manual every time. This feature lets users save that mapping as a rule and have it applied automatically to new and existing uncategorized transactions.

Scope: Plaid-sourced transactions only (rules key off `merchant_entity_id`, Plaid's stable per-merchant identifier). Manual and CSV transactions have no entity ID and are not affected.

---

## Data Model

New table: `public.category_rules`

```sql
create table public.category_rules (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  merchant_entity_id  text not null,
  merchant_name       text not null,  -- display label captured at rule creation
  schedule_c_category text not null,
  created_at          timestamptz not null default now(),
  unique (user_id, merchant_entity_id)
);

create index on public.category_rules (user_id, merchant_entity_id);
```

RLS policies (standard pattern):
- `SELECT` / `INSERT` / `UPDATE` / `DELETE` all require `user_id = auth.uid()`.

`merchant_name` is captured from the transaction at rule creation time — Plaid entity IDs are opaque strings and need a human-readable label for display.

One rule per merchant per user (unique constraint). A rule update (e.g. changing the category) is an upsert on `(user_id, merchant_entity_id)`.

---

## Rule Creation — Transaction Detail Slide-Over

Rules are created from the transaction detail panel, not from a dedicated settings form. The entry point is where the user already has context (they just categorized this transaction and realize they always do the same thing for this merchant).

**Visibility condition:** a rule hint row is shown below the category dropdown when:
- `transaction.merchant_entity_id` is non-null (Plaid transaction with a known merchant), AND
- `transaction.schedule_c_category` is non-null (user has picked a category — no point saving "Uncategorized")

**No rule exists for this merchant:**
> "Always use [Shipping & Postage] for USPS? **Save rule**"

Clicking "Save rule" calls `createOrUpdateCategoryRule`. Inline confirmation on success.

**Rule already exists:**
> "Rule active: USPS → [Shipping & Postage] · **Change** · **Remove**"

- **Change** — opens the same category dropdown; re-saves on selection.
- **Remove** — deletes the rule (hard delete, no confirm needed — rules are trivially re-created).

The hint row updates reactively when the user changes the category dropdown, so the flow is: pick category → click "Save rule" → done in two actions.

---

## Rule Application

### On Sync (new transactions)

`plaid_sync_transactions` already processes incoming transactions in a batch before upserting. Add a single pre-batch lookup:

```sql
SELECT merchant_entity_id, schedule_c_category
FROM category_rules
WHERE user_id = $user_id
  AND merchant_entity_id = ANY($incoming_entity_ids)
```

Build a `Map<entityId, category>` from the result. For each incoming transaction, if its `merchant_entity_id` is in the map and its `schedule_c_category` would be null, stamp the category from the rule before inserting. One extra query per sync call regardless of batch size.

### Backfill (existing uncategorized rows)

New Postgres function `apply_category_rules(p_user_id uuid) RETURNS integer`:

```sql
create or replace function public.apply_category_rules(p_user_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  with updated as (
    update transactions t
    set schedule_c_category = r.schedule_c_category
    from category_rules r
    where t.user_id = p_user_id
      and r.user_id = p_user_id
      and t.merchant_entity_id = r.merchant_entity_id
      and t.schedule_c_category is null
    returning t.id
  )
  select count(*)::integer from updated;
$$;
```

`SECURITY DEFINER` so it runs as the service role, but hard-filters on the passed `p_user_id`. Called from the client as `supabase.rpc('apply_category_rules', { p_user_id: user.id })`.

---

## Settings — Rules Management Section

A new "Auto-categorization Rules" section in `SettingsPage.tsx`, below Custom Categories.

**Contents:**
- Rule list: merchant name + `CategoryBadge` + delete (trash) icon per row.
- Empty state: "No rules yet — open a transaction and set a category to create one."
- **"Apply Rules Now"** button: calls `apply_category_rules` RPC, shows toast "Applied rules to N transactions." Disabled while running. Useful after creating rules or after a large import.

No "add rule" form in Settings — creation is intentionally only from the transaction detail panel.

---

## Client Mutations & Queries

**`mutations.ts`** additions:
- `createOrUpdateCategoryRule({ merchant_entity_id, merchant_name, schedule_c_category })` — upsert on `(user_id, merchant_entity_id)`, invalidates `['category_rules']`
- `deleteCategoryRule(id)` — hard delete, invalidates `['category_rules']`
- `applyAllCategoryRules()` — calls `apply_category_rules` RPC, returns `{ count: number }`, invalidates `['transactions']` (rows were updated)

**Queries** (inline on SettingsPage, or `queries.ts`):
- `useCategoryRules()` — `SELECT * FROM category_rules WHERE user_id = auth.uid() ORDER BY merchant_name`. Keyed as `['category_rules']`. Both SettingsPage and the transaction detail panel call this hook; React Query deduplicates the fetch and shares the cache. The detail panel derives the "rule exists?" state by filtering the result by `merchant_entity_id` — no extra query.

---

## Edge Cases

- **Transaction has no `merchant_entity_id`:** hint row hidden; rules never apply. No fallback to name-based matching in this version.
- **Rule category deleted (soft-delete):** the stored `schedule_c_category` value still resolves via `resolveCategory` — it will show as "[Category] (deleted)" in the hint row. The user should update or remove the rule. No automated cleanup needed.
- **Sync applies rule, user immediately changes category:** user's manual override wins; the row's category is updated. The rule is unchanged — it will apply to future new transactions for that merchant. This is the intended behavior (rule is a default, not a lock).
- **`apply_category_rules` run twice:** idempotent — the `schedule_c_category IS NULL` filter means already-categorized rows are never touched.
- **Multiple rules for same entity ID:** impossible — unique constraint on `(user_id, merchant_entity_id)`.

---

## Migration

One migration file: `supabase/migrations/<timestamp>_category_rules.sql`
- Creates `category_rules` table with index and RLS policies.
- Creates `apply_category_rules` function.

`plaid_sync_transactions` change is a Deno edge function edit — deployed separately.

---

## Out of Scope (v1)

- Name-based / substring matching for manual and CSV transactions
- Auto-capture of Plaid entity ID into rule when creating from a transaction (the entity ID is already on the transaction row; merchant_name is the display field captured at save time — no extra Plaid API call needed)
- Rule priority ordering (not needed with one rule per merchant)
- Rule import/export
- Applying rules to already-categorized rows (by design: only null rows are affected)
