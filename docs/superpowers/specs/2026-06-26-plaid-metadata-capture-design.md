# Plaid metadata capture — design

> **Status:** spec, not yet implemented.
> **Predecessor PR:** [`feat/settings-and-plaid`](https://github.com/chriscrobinson18/reseller_dashboard_web/pull/new/feat/settings-and-plaid) — Settings page and Plaid Link wiring; must merge before this lands so the same `plaid_sync_transactions` source isn't being edited on two branches.
> **Author:** brainstormed 2026-06-26.

## Problem

`plaid_sync_transactions` v38 receives ~20 fields per transaction from Plaid and persists 6. Everything else is silently dropped. The `TransactionDetail` slide-over on the Expenses page then displays a subset of that subset. Capturing more upstream lets us show merchant logos, store locations, payment channel, pending status, and finer-grained Plaid categorization without losing anything to a schema migration later.

## Goal

Richer transaction UI on the Expenses page. **Not** auto-categorization, **not** audit/receipt-replacement, **not** raw-payload retention as the primary purpose — those are downstream possibilities the capture enables, but this spec only ships the capture + UI display.

## Non-goals (explicit)

- Tax-math treatment of `pending` rows is unchanged. They still count toward Schedule C totals exactly like today. Strict cash-basis would arguably exclude until cleared; that is a separate P0 tax-correctness discussion.
- `merchant_entity_id` is captured but unused. It exists to unblock a future `category_rules` table; no rule engine in this spec.
- Auto-categorization upgrades using `plaid_category_detailed` + `confidence_level` are deferred. The PFC mapping in `plaid_sync_transactions` keeps using `primary` only.
- Pulling more fields out of `plaid_metadata` jsonb (counterparties, payment_meta, lat/lon, transaction_code, check_number) is deferred to focused follow-ups.
- No Plaid Transactions webhook (separate P3 item in TASKS.md).

## Schema

Migration `plaid_metadata_capture` adds 14 nullable columns to `public.transactions`:

| Column | Type | Plaid source |
|---|---|---|
| `merchant_logo_url` | `text` | `logo_url` |
| `merchant_website` | `text` | `website` |
| `merchant_entity_id` | `text` | `merchant_entity_id` |
| `location_city` | `text` | `location.city` |
| `location_region` | `text` | `location.region` (state) |
| `location_store_number` | `text` | `location.store_number` |
| `payment_channel` | `text` | `payment_channel` (`'online' \| 'in store' \| 'other'`) |
| `authorized_date` | `date` | `authorized_date` |
| `iso_currency_code` | `text` | `iso_currency_code` (e.g. `'USD'`) |
| `pending` | `boolean NOT NULL DEFAULT false` | `pending` |
| `pending_plaid_transaction_id` | `text` | `pending_transaction_id` |
| `plaid_category_detailed` | `text` | `personal_finance_category.detailed` |
| `plaid_category_confidence` | `text` | `personal_finance_category.confidence_level` |
| `plaid_metadata` | `jsonb` | the entire raw transaction object (safety net) |

Notes:
- No CHECK constraints on the text enumerations (`payment_channel`, `plaid_category_confidence`) — Plaid can extend these without warning; treating them as opaque strings avoids migration churn.
- No new indexes. None of these are query keys yet. `merchant_entity_id` may get an index when the category-rules feature ships.
- Backfill for existing 3,705 rows happens via the existing **Force Full Resync** flow (see "Backfill" below). No data migration is needed in the SQL migration itself.

## Sync logic — `plaid_sync_transactions` v32

Three changes inside the per-item loop, all in `index.ts`.

### Change 1 — `buildRow()` extended

`buildRow()` returns the same shape as today plus the 14 new fields, each derived from the raw `tx`:

```ts
function buildRow(tx: any, userId: string, accountMap: Record<string, string>) {
  const merchant = tx.merchant_name || tx.name
  const settlement = classifySettlement(merchant, tx.amount)
  const loc = tx.location ?? {}
  const pfc = tx.personal_finance_category ?? {}
  return {
    user_id: userId,
    plaid_transaction_id: tx.transaction_id,
    date: tx.date,
    amount: -tx.amount,
    merchant,
    type: getTransactionType(tx),
    source: 'plaid',
    account_display: accountMap[tx.account_id] ?? null,
    plaid_category: pfc.primary ?? null,
    record_type: settlement?.record_type ?? 'transaction',
    platform: settlement?.platform ?? null,
    ...(settlement ? { schedule_c_category: settlement.schedule_c_category } : {}),
    // ── new fields ──
    merchant_logo_url: tx.logo_url ?? null,
    merchant_website: tx.website ?? null,
    merchant_entity_id: tx.merchant_entity_id ?? null,
    location_city: loc.city ?? null,
    location_region: loc.region ?? null,
    location_store_number: loc.store_number ?? null,
    payment_channel: tx.payment_channel ?? null,
    authorized_date: tx.authorized_date ?? null,
    iso_currency_code: tx.iso_currency_code ?? null,
    pending: tx.pending === true,
    pending_plaid_transaction_id: tx.pending_transaction_id ?? null,
    plaid_category_detailed: pfc.detailed ?? null,
    plaid_category_confidence: pfc.confidence_level ?? null,
    plaid_metadata: tx,
  }
}
```

The existing `added` upsert (`ignoreDuplicates: true`) is unchanged. For brand-new transactions it inserts the row with all 14 fields populated. For transactions Plaid re-delivers (existing `plaid_transaction_id`), it skips — Change 2 picks them up.

### Change 2 — metadata refresh UPDATE pass

After the `added` upsert, run a side-channel UPDATE on every row in this sync's `added` batch. The SET clause is the 14 new metadata columns only — see `plaidMetadataFields(row)` helper below. Canonical economic fields (`amount`, `date`, `merchant`, `type`) are write-once at insert time; user-editable fields (`schedule_c_category`, `notes`, `related_sale_id`, `receipt_url`, `parent_settlement_id`) are deliberately excluded.

```ts
for (let i = 0; i < rows.length; i += BATCH) {
  const slice = rows.slice(i, i + BATCH)
  for (const r of slice) {
    await supabase.from('transactions').update({
      merchant_logo_url: r.merchant_logo_url,
      merchant_website: r.merchant_website,
      merchant_entity_id: r.merchant_entity_id,
      location_city: r.location_city,
      location_region: r.location_region,
      location_store_number: r.location_store_number,
      payment_channel: r.payment_channel,
      authorized_date: r.authorized_date,
      iso_currency_code: r.iso_currency_code,
      pending: r.pending,
      pending_plaid_transaction_id: r.pending_plaid_transaction_id,
      plaid_category_detailed: r.plaid_category_detailed,
      plaid_category_confidence: r.plaid_category_confidence,
      plaid_metadata: r.plaid_metadata,
    })
    .eq('plaid_transaction_id', r.plaid_transaction_id)
    .eq('user_id', userId)
  }
}
```

User-editable columns (`schedule_c_category`, `notes`, `related_sale_id`, `receipt_url`, `parent_settlement_id`) are deliberately absent from the SET clause. The same code path covers two cases:

- **Normal incremental sync** — refreshes metadata if Plaid mutates it (logo URL, confidence level, etc.) on a re-delivered tx.
- **Force Full Resync** — backfills all 14 new columns onto every pre-existing row.

A row-by-row loop is acceptable here; Supabase JS doesn't expose a multi-row UPDATE with different per-row values, and even a 5,000-tx full resync stays within edge function timeout limits (each UPDATE is a single PK-keyed mutation, sub-millisecond on the DB side).

### Change 3 — pending → posted handoff

Plaid's lifecycle for a transaction:

1. Day 1 — tx `A` arrives in `added` with `pending: true`, `pending_transaction_id: null`. Inserted normally.
2. Day 3 — Plaid `removed`s `A` **and** `added`s `B` with `pending_transaction_id: A.transaction_id`.

Default behavior would `delete A; insert B`, which destroys any user edits on `A` (notes, manually-set category, attached receipt, sale link). Instead, rename row `A` in place to look like row `B`:

```ts
// At top of "added" processing, before the regular upsert:
const consumedPendingIds = new Set<string>()
const reattachedAdds: any[] = []
const freshAdds: any[] = []

for (const tx of addedTx) {
  if (tx.pending_transaction_id) {
    const { data: existing } = await supabase
      .from('transactions')
      .select('id')
      .eq('plaid_transaction_id', tx.pending_transaction_id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (existing) {
      // Defensive: confirm the posted row B isn't already in the DB (e.g. from
      // a prior partial run). If it is, drop the pending row A and let B stand.
      const { data: existingPosted } = await supabase
        .from('transactions')
        .select('id')
        .eq('plaid_transaction_id', tx.transaction_id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (existingPosted) {
        await supabase.from('transactions').delete().eq('id', existing.id)
      } else {
        // Rename A → B in place: change the plaid id, flip pending=false,
        // refresh every Plaid-derived field. SET clause = `plaidRowFields(row)`,
        // which is everything buildRow() produces EXCEPT the user-editable
        // fields (schedule_c_category, notes, related_sale_id, receipt_url,
        // parent_settlement_id). It's a superset of `plaidMetadataFields`
        // because the rename also writes plaid_transaction_id, pending,
        // amount, date, merchant, type, account_display, plaid_category,
        // record_type, platform.
        await supabase.from('transactions').update(plaidRowFields(r)).eq('id', existing.id)
      }
      consumedPendingIds.add(tx.pending_transaction_id)
      reattachedAdds.push(tx) // skipped from the regular upsert below
      continue
    }
  }
  freshAdds.push(tx)
}
```

Then the regular `added` upsert runs over `freshAdds` only. And the `removed` loop skips any tx whose `transaction_id` is in `consumedPendingIds`:

```ts
const trulyRemoved = removedTx.filter(tx => !consumedPendingIds.has(tx.transaction_id))
// ... then the existing removedIds logic operates on trulyRemoved
```

## Backfill

No separate backfill code. The **Force Full Resync** button (kebab menu on each `BankItemCard` — already ships in the Settings PR) calls `plaid_sync_transactions` with `reset_cursor: true`. The edge function clears the stored cursor and Plaid re-delivers full history. Every transaction flows through Change 2's UPDATE pass, populating the 14 new columns on every pre-existing row. User edits stay untouched (categories, notes, sale links, receipts — none of those columns are in the SET clause).

Operational guidance to add to `docs/features/settings.md` (or a follow-up doc): "After the metadata capture migration applies, run **Force Full Resync** once per connected bank to backfill merchant logos, locations, and payment channel onto historical transactions."

## Client types — `src/lib/types.ts`

Extend `Transaction` with all 14 new fields, all optional:

```ts
export interface Transaction {
  // ... existing fields ...
  merchant_logo_url?: string | null
  merchant_website?: string | null
  merchant_entity_id?: string | null
  location_city?: string | null
  location_region?: string | null
  location_store_number?: string | null
  payment_channel?: 'online' | 'in store' | 'other' | string | null
  authorized_date?: string | null
  iso_currency_code?: string | null
  pending?: boolean
  pending_plaid_transaction_id?: string | null
  plaid_category_detailed?: string | null
  plaid_category_confidence?: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH' | string | null
  plaid_metadata?: Record<string, unknown> | null
}
```

The union-of-known-and-string typing on `payment_channel` and `plaid_category_confidence` documents the expected values without breaking forward compatibility if Plaid adds new ones.

## UI — `TransactionDetail` slide-over (`ExpensesPage.tsx`)

Additions, top to bottom:

### Header zone (above existing fields)

- **Merchant logo** — 32×32 `<img>` next to the merchant name when `merchant_logo_url` is set. Fallback: first-letter circle on the existing gray background (so layout never jumps when the URL is null). Reusable as a small `<MerchantAvatar />` component.
- **Pending pill** — amber "Pending" badge next to the merchant name when `pending=true`. Subtitle below: "Will finalize within a few days."
- **Merchant link** — when `merchant_website` is set, wrap the merchant name in `<a href={merchant_website} target="_blank" rel="noopener noreferrer">` with an external-link icon. Plain text otherwise.

### Date row

If `authorized_date` exists and differs from `date`, render `Purchased Jan 15 · Posted Jan 18`. Otherwise keep the current single-date display.

### "Details" group (new, below notes)

Two-column grid, each field conditionally rendered when non-null:

- **Payment channel** — small pill: `Online` / `In store` / `Other`.
- **Location** — formatted `City, Region · Store #N` (omitting missing parts cleanly).
- **Currency** — only render if `iso_currency_code` is non-null and not `'USD'`.

### Existing "Plaid category" line, upgraded

- Current: `Plaid category: FOOD_AND_DRINK`
- New: `Plaid category: FOOD_AND_DRINK / FAST_FOOD` plus a `HIGH` confidence pill when both `plaid_category_detailed` and `plaid_category_confidence` are present.

### Out of UI scope

Captured but not surfaced (live in `plaid_metadata`):
- Geo lat/lon, full street address
- Counterparties array
- Payment-meta object (reference_number, ppd_id, payment_processor)
- Transaction code (wire / ach / direct deposit)
- Check number
- `merchant_entity_id`

## Tax-correctness review

| Concern | Result |
|---|---|
| Will Force Full Resync overwrite user-set `schedule_c_category`? | **No.** The Change 2 UPDATE pass excludes `schedule_c_category` from the SET clause. The existing `added` upsert uses `ignoreDuplicates: true`, so it skips existing rows entirely. The PFC auto-categorize pass at the end of the sync uses `.is('schedule_c_category', null)`, so it never touches categorized rows. |
| Will the resync create duplicate transaction rows? | **No.** `transactions.plaid_transaction_id` has a `UNIQUE` constraint. Plaid re-delivering the same `transaction_id` becomes a no-op insert. The Change 3 pending→posted handoff renames a pending row's id to the posted id; defensive check guards against the rare case where the posted row already exists. |
| Do `pending` rows skew Schedule C totals? | **Unchanged.** Pending rows count toward totals exactly like today. Strict-cash-basis treatment is deferred to a future P0 discussion. |
| Does the metadata refresh write `amount`, `date`, or `merchant`? | **No.** Change 2 only writes the 14 new columns. The canonical economic fields (`amount`, `date`, `merchant`, `type`) are written by the original upsert at insert time only. |

## Files touched

| Path | Change |
|---|---|
| `supabase/migrations/<ts>_plaid_metadata_capture.sql` | new — adds 14 columns |
| `supabase/functions/plaid_sync_transactions/index.ts` | extended — `buildRow`, metadata refresh pass, pending→posted handoff. Bump comment to `v32`. |
| `src/lib/types.ts` | extended — `Transaction` interface |
| `src/pages/ExpensesPage.tsx` | `TransactionDetail` slide-over additions |
| `src/components/MerchantAvatar.tsx` | new — reusable 32×32 logo-or-initial component |
| `docs/supabase-schema.md` | document the 14 new columns under `transactions` |
| `docs/features/expenses.md` | note the new fields surfaced in the detail panel |
| (optional) `docs/features/settings.md` | one-line callout: "Run Force Full Resync once after this migration to backfill historical rows." |

## Testing

No new vitest cases are mandatory — none of the new logic is pure money math. Two pieces are worth specs if time allows:

- **`buildRow` field mapping** — fixture-driven test: feed in a sample Plaid `transactionsSync` `added[]` entry, assert every one of the 14 new fields lands where expected.
- **Pending → posted handoff** — fixture test for the logic that picks `existing` vs. `existingPosted` vs. `freshAdds`. (Edge function code; consumable from a Deno test under `supabase/functions/plaid_sync_transactions/_test.ts` if the project starts adopting Deno tests for this function. Mirror the pattern already used in `record_sale`'s test.)

Both deferable — the logic is mechanical enough that the manual smoke test in the implementation plan (sync once, verify each new column on a sampled row, run Force Full Resync, verify backfill) is sufficient for v1.

## Operational checklist

1. Merge the Settings PR (`feat/settings-and-plaid`) first.
2. Apply migration.
3. Deploy `plaid_sync_transactions` v32.
4. Web client deploy with the UI changes.
5. From Settings, hit **Force Full Resync** on every connected institution. Confirm sample rows now have logos / locations / channel populated.
