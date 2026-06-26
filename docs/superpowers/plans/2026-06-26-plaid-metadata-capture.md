# Plaid Metadata Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture ~14 additional fields from each Plaid transaction (logo, location, payment channel, pending flag, detailed PFC + confidence, currency, raw metadata) and surface them in the Expenses transaction detail panel.

**Architecture:** New migration adds 13 typed columns + 1 jsonb to `transactions`. Edge function `plaid_sync_transactions` extends `buildRow`, adds a side-channel metadata UPDATE pass (so Force Full Resync backfills existing rows without touching user edits), and handles Plaid's pending→posted handoff by renaming rows in place. Client adds a `MerchantAvatar` component and extends `TransactionDetail` with logo, pending pill, dual dates, location, payment channel, currency, and detailed PFC.

**Tech Stack:** Postgres migration via Supabase MCP, Deno edge function (`@supabase/supabase-js@2`, `plaid` SDK), TypeScript/React (Vite, Tailwind), lucide-react icons.

**Spec:** [`docs/superpowers/specs/2026-06-26-plaid-metadata-capture-design.md`](../specs/2026-06-26-plaid-metadata-capture-design.md)

**Model routing (per `/CLAUDE.md`):**

| Task | Model | Effort |
|---|---|---|
| 1 — Migration + schema doc | inline (Opus) | none |
| 2 — Extend `Transaction` interface | Haiku | none |
| 3 — Edge function patch | Sonnet | `think` |
| 4 — Deploy edge function | inline (Opus) | none |
| 5 — `MerchantAvatar` component | Haiku | none |
| 6 — `TransactionDetail` UI additions | Sonnet | `think` |
| 7 — Docs sweep (expenses + settings) | Haiku | none |
| 8 — Manual E2E + PR | inline (Opus) | none |

**Branch:** `feat/plaid-metadata-capture` (already cut from main).

---

## Task 1: Apply `plaid_metadata_capture` migration + update schema doc

**Files:**
- Create: `supabase/migrations/20260626130000_plaid_metadata_capture.sql`
- Modify: `docs/supabase-schema.md` (extend the `transactions` table section)

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260626130000_plaid_metadata_capture.sql
alter table public.transactions
  add column merchant_logo_url text,
  add column merchant_website text,
  add column merchant_entity_id text,
  add column location_city text,
  add column location_region text,
  add column location_store_number text,
  add column payment_channel text,
  add column authorized_date date,
  add column iso_currency_code text,
  add column pending boolean not null default false,
  add column pending_plaid_transaction_id text,
  add column plaid_category_detailed text,
  add column plaid_category_confidence text,
  add column plaid_metadata jsonb;

comment on column public.transactions.plaid_metadata is
  'Raw Plaid transactionsSync row as-is. Safety net for fields not broken out into typed columns.';
comment on column public.transactions.pending is
  'Plaid pending flag. Pending rows still count toward Schedule C totals (cash-basis treatment unchanged).';
comment on column public.transactions.pending_plaid_transaction_id is
  'When set on a posted row, points to the prior pending row''s plaid_transaction_id. Used by sync to rename pending rows in place rather than delete+insert.';
```

- [ ] **Step 2: Apply via Supabase MCP**

Invoke `mcp__supabase__apply_migration` with:
- `name`: `plaid_metadata_capture`
- `query`: the SQL above (without the SQL comment lines for compactness if needed)

Expected: `{"success": true}`.

- [ ] **Step 3: Verify columns exist**

Invoke `mcp__supabase__execute_sql` with:

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'transactions'
  and column_name in (
    'merchant_logo_url','merchant_website','merchant_entity_id',
    'location_city','location_region','location_store_number',
    'payment_channel','authorized_date','iso_currency_code',
    'pending','pending_plaid_transaction_id',
    'plaid_category_detailed','plaid_category_confidence','plaid_metadata'
  )
order by column_name;
```

Expected: 14 rows. `pending` has `data_type = 'boolean'`, `is_nullable = 'NO'`, `column_default = 'false'`. `authorized_date` has `data_type = 'date'`. `plaid_metadata` has `data_type = 'jsonb'`. The rest are text.

- [ ] **Step 4: Update `docs/supabase-schema.md`**

In the existing `### transactions` block (around line 14), add the new columns to whichever rows table format the doc uses. Append a new sub-block at the end of that section:

```markdown
### Plaid metadata fields (added 2026-06-26 by `plaid_metadata_capture`)

Populated by `plaid_sync_transactions` v39+. All nullable; absent when source ≠ `'plaid'`. Backfill on existing rows happens via the **Force Full Resync** kebab option in Settings — see [`features/settings.md`](features/settings.md).

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
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260626130000_plaid_metadata_capture.sql docs/supabase-schema.md
git commit -m "feat(plaid-metadata): add 14 columns to transactions for richer UI"
```

---

## Task 2: Extend `Transaction` interface

**Files:**
- Modify: `src/lib/types.ts` (the existing `Transaction` interface block)

- [ ] **Step 1: Append the 14 fields to `Transaction`**

Open `src/lib/types.ts`. Inside `interface Transaction { ... }`, after the last existing field (currently `is_non_cash`), add:

```ts
  // ── Plaid metadata (populated by plaid_sync_transactions v39+; null when source ≠ 'plaid'). ──
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
```

The mixed-union typing on `payment_channel` and `plaid_category_confidence` documents expected values without breaking forward compat if Plaid adds new ones.

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(plaid-metadata): extend Transaction interface with 14 fields"
```

---

## Task 3: Edge function — extend `buildRow`, add helpers, metadata UPDATE pass, pending→posted handoff

**Files:**
- Modify: `supabase/functions/plaid_sync_transactions/index.ts`

Build off the version that landed in PR #(settings + plaid) — `v38` with CORS. If the Settings PR isn't merged yet, base this work on `supabase/functions/plaid_sync_transactions/index.ts` from that branch and rebase if needed.

This task makes one cohesive edit to one file. It changes 3 things:

- **(a)** `buildRow()` returns the 14 new fields.
- **(b)** Two helpers `plaidMetadataFields(row)` and `plaidRowFields(row)` extract subsets used by Change 2 / Change 3.
- **(c)** Per-item sync loop runs the pending→posted handoff before the existing `added` upsert, and the metadata refresh UPDATE pass after.

- [ ] **Step 1: Bump version header**

Replace the top comment block (lines 1–7 of the current v38) with:

```ts
// plaid_sync_transactions v39
// Adds rich Plaid metadata capture: 14 new columns on transactions (logo, location,
// payment_channel, authorized_date, pending, detailed PFC + confidence, currency,
// plaid_metadata jsonb). A side-channel metadata UPDATE pass refreshes those fields
// on existing rows (so Force Full Resync backfills history without overwriting user
// edits: schedule_c_category, notes, related_sale_id, receipt_url, parent_settlement_id).
// Pending→posted handoff renames pending rows in place using pending_transaction_id,
// preserving any user edits on the pending row instead of delete-then-insert.
// CORS: handles OPTIONS preflight and returns Access-Control-Allow-Origin on every
// response so the web client (browser) can call this function. iOS native HTTPS
// callers ignore these headers — additive change, no behavioral impact for mobile.
// Settlement classification: sign-aware, precise merchant patterns.
// Positive credits (tx.amount < 0 in Plaid) from marketplace merchants = settlements.
// Negative debits (purchases on eBay/Amazon) are NOT settlements.
```

- [ ] **Step 2: Extend `buildRow()`**

Replace the existing `buildRow` function (currently lines ~97–114) with:

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
    // ── new fields (v39) ──
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

- [ ] **Step 3: Add the two helpers**

Below `buildRow`, before the `const BATCH = 200` line, add:

```ts
/**
 * The 14 metadata columns added in v39. Used by the side-channel UPDATE pass
 * to refresh metadata on existing rows without touching user edits or the
 * canonical economic fields (amount/date/merchant/type).
 */
function plaidMetadataFields(r: ReturnType<typeof buildRow>) {
  return {
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
  }
}

/**
 * Everything buildRow() produces EXCEPT user-editable fields. Used by the
 * pending→posted handoff to rename a pending row into a posted row in place
 * (changes plaid_transaction_id, pending, amount/date/merchant if they
 * changed, and all metadata) while preserving schedule_c_category, notes,
 * related_sale_id, receipt_url, parent_settlement_id.
 */
function plaidRowFields(r: ReturnType<typeof buildRow>) {
  // Strip the fields the user owns.
  const { ...rest } = r
  delete (rest as any).schedule_c_category
  // user_id is set on insert; never overwrite during a rename.
  delete (rest as any).user_id
  return rest
}
```

- [ ] **Step 4: Rewrite the per-item processing block**

Locate the existing per-item `for (const item of plaidItems) { try { ... } }` loop. Inside the `try` block, replace everything from the `if (addedTx.length > 0) { ... }` block through (and including) the existing `if (modifiedTx.length > 0) { ... }` and `if (removedTx.length > 0) { ... }` blocks with the version below. The earlier accumulation (`while (hasMore) { ... }`) stays as-is.

```ts
        // ── v39: pending → posted handoff ──
        // Plaid removes the pending row and adds a new posted row with
        // pending_transaction_id pointing back. Rename the existing row
        // in place instead of delete+insert so user edits survive.
        const consumedPendingIds = new Set<string>()
        const freshAdds: any[] = []
        for (const tx of addedTx) {
          if (tx.pending_transaction_id) {
            const { data: existingPending } = await supabase
              .from('transactions')
              .select('id')
              .eq('plaid_transaction_id', tx.pending_transaction_id)
              .eq('user_id', user.id)
              .maybeSingle()

            if (existingPending) {
              // Defensive: confirm the posted row B isn't already in the DB
              // (e.g. a prior partial run inserted it). If it is, drop the
              // pending row A and let B stand.
              const { data: existingPosted } = await supabase
                .from('transactions')
                .select('id')
                .eq('plaid_transaction_id', tx.transaction_id)
                .eq('user_id', user.id)
                .maybeSingle()

              const renamed = buildRow(tx, user.id, accountMap)
              if (existingPosted) {
                await supabase.from('transactions').delete().eq('id', existingPending.id)
              } else {
                const { error: renameErr } = await supabase
                  .from('transactions')
                  .update(plaidRowFields(renamed))
                  .eq('id', existingPending.id)
                if (renameErr) console.error('Pending→posted rename error:', renameErr)
              }
              consumedPendingIds.add(tx.pending_transaction_id)
              continue
            }
          }
          freshAdds.push(tx)
        }

        // ── existing added insertion (unchanged behavior, freshAdds only) ──
        if (freshAdds.length > 0) {
          const rows = freshAdds.map((tx: any) => buildRow(tx, user.id, accountMap))
          const settlements = rows.filter((r) => r.record_type === 'settlement').length
          totalSettlements += settlements
          if (settlements > 0) console.log(`Item ${item.item_id}: ${settlements} settlements detected`)

          for (let i = 0; i < rows.length; i += BATCH) {
            const { error } = await supabase
              .from('transactions')
              .upsert(rows.slice(i, i + BATCH), { onConflict: 'plaid_transaction_id', ignoreDuplicates: true })
            if (error) console.error('Upsert added error:', error)
          }
          for (const [pfc, scheduleC] of Object.entries(PFC_TO_SCHEDULE_C)) {
            await supabase
              .from('transactions')
              .update({ schedule_c_category: scheduleC })
              .eq('user_id', user.id)
              .eq('plaid_category', pfc)
              .eq('record_type', 'transaction')
              .is('schedule_c_category', null)
          }
          totalAdded += freshAdds.length
        }

        // ── v39: metadata refresh pass ──
        // Refresh the 14 metadata columns on every row Plaid re-delivered in
        // this sync's added batch (whether freshly inserted or pre-existing).
        // User-editable fields are excluded from the SET clause.
        const refreshRows = addedTx.map((tx: any) => buildRow(tx, user.id, accountMap))
        for (const r of refreshRows) {
          const { error: metaErr } = await supabase
            .from('transactions')
            .update(plaidMetadataFields(r))
            .eq('plaid_transaction_id', r.plaid_transaction_id)
            .eq('user_id', user.id)
          if (metaErr) console.error('Metadata refresh error:', metaErr)
        }

        // ── existing modified path (unchanged) ──
        if (modifiedTx.length > 0) {
          const rows = modifiedTx.map((tx: any) => buildRow(tx, user.id, accountMap))
          for (let i = 0; i < rows.length; i += BATCH) {
            const { error } = await supabase
              .from('transactions')
              .upsert(rows.slice(i, i + BATCH), { onConflict: 'plaid_transaction_id', ignoreDuplicates: false })
            if (error) console.error('Upsert modified error:', error)
          }
          totalModified += modifiedTx.length
        }

        // ── v39: removed-skip filter ──
        // Pending rows that we just renamed into posted rows above will
        // appear in Plaid's `removed`. Skip them — we already kept the row.
        const trulyRemoved = removedTx.filter(
          (tx: any) => !consumedPendingIds.has(tx.transaction_id),
        )
        if (trulyRemoved.length > 0) {
          const removedIds = trulyRemoved.map((tx: any) => tx.transaction_id)
          const { data: withReceipts } = await supabase
            .from('transactions')
            .select('receipt_url')
            .in('plaid_transaction_id', removedIds)
            .eq('user_id', user.id)
            .not('receipt_url', 'is', null)
          if (withReceipts?.length) {
            await supabase.storage.from('receipts').remove(withReceipts.map((r: any) => r.receipt_url))
          }
          for (let i = 0; i < removedIds.length; i += BATCH) {
            await supabase.from('transactions').delete()
              .in('plaid_transaction_id', removedIds.slice(i, i + BATCH))
              .eq('user_id', user.id)
          }
          totalRemoved += trulyRemoved.length
        }
```

- [ ] **Step 5: Verify TypeScript-shape of the file**

The function isn't part of the npm/vite build (Deno runtime). Sanity-check by grepping the new identifiers:

```bash
grep -n "plaidMetadataFields\|plaidRowFields\|consumedPendingIds\|freshAdds\|trulyRemoved" supabase/functions/plaid_sync_transactions/index.ts
```

Expected: 6+ matches across the function. If any helper is referenced but not defined, fix before deploy.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/plaid_sync_transactions/index.ts
git commit -m "feat(plaid-metadata): capture 14 fields, metadata refresh pass, pending→posted handoff"
```

---

## Task 4: Deploy `plaid_sync_transactions` v39

**Files:** none (server-side deploy).

- [ ] **Step 1: Deploy via Supabase MCP**

Invoke `mcp__supabase__deploy_edge_function` with:
- `name`: `plaid_sync_transactions`
- `entrypoint_path`: `index.ts`
- `verify_jwt`: `true`
- `files`: `[{ name: 'index.ts', content: <full file contents from Task 3> }]`

Expected response: a `version` integer ≥ 39 with `status: 'ACTIVE'`.

- [ ] **Step 2: Sanity-check via logs**

Invoke `mcp__supabase__get_logs` with `service: 'edge-function'`. Expected: any prior log lines visible; no startup-error entries from the new deploy.

(If the deploy step in Task 1's response said `"success": false`, stop and surface the error — do not proceed to Task 5.)

- [ ] **Step 3: Optional — trigger one sync to validate**

The web client (if running locally) can hit **Sync Now** from Settings. Or invoke the function directly:

```bash
# Only if comfortable with shell-side curl; otherwise skip and rely on web UI in Task 8.
```

Skip if no local environment is set up; Task 8's manual smoke test covers this end-to-end.

(No commit — server-side deploy has no local artifacts. The v39 source already committed in Task 3 is the version control.)

---

## Task 5: Build `MerchantAvatar` component

**Files:**
- Create: `src/components/MerchantAvatar.tsx`

- [ ] **Step 1: Write the component**

```tsx
// src/components/MerchantAvatar.tsx
import { useState } from 'react'

interface Props {
  /** Plaid logo URL. Falls back to initial circle if null or fails to load. */
  logoUrl?: string | null
  /** Merchant name — used for the fallback initial and alt text. */
  merchant: string | null
  /** Pixel size of the square avatar. Default 32. */
  size?: number
}

/**
 * Square avatar for a merchant. Renders the Plaid logo when available, falls
 * back to a gray circle with the first letter of the merchant name. Layout
 * is identical in both cases so the slot doesn't jump when an image loads
 * or fails.
 */
export default function MerchantAvatar({ logoUrl, merchant, size = 32 }: Props) {
  const [broken, setBroken] = useState(false)
  const dim = { width: size, height: size }
  const initial = (merchant ?? '?').trim().charAt(0).toUpperCase() || '?'

  if (logoUrl && !broken) {
    return (
      <img
        src={logoUrl}
        alt={merchant ?? 'Merchant logo'}
        onError={() => setBroken(true)}
        className="rounded-full bg-gray-100 object-contain"
        style={dim}
      />
    )
  }

  return (
    <div
      className="rounded-full bg-gray-100 text-gray-500 flex items-center justify-center font-medium"
      style={{ ...dim, fontSize: Math.max(12, Math.floor(size * 0.45)) }}
      aria-label={merchant ?? 'Merchant'}
    >
      {initial}
    </div>
  )
}
```

- [ ] **Step 2: Verify build + lint**

```bash
npm run build 2>&1 | grep -E "error|✓ built" | tail -3
npm run lint 2>&1 | tail -3
```

Expected: build passes; lint passes (0 errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/MerchantAvatar.tsx
git commit -m "feat(plaid-metadata): MerchantAvatar with logo + fallback initial"
```

---

## Task 6: Extend `TransactionDetail` in `ExpensesPage.tsx`

**Files:**
- Modify: `src/pages/ExpensesPage.tsx` (the `TransactionDetail` component and its imports)

Per the spec's UI section. Renders only the fields that are non-null; missing data stays invisible. Conditional rendering keeps the panel quiet for manual / non-Plaid transactions.

- [ ] **Step 1: Add imports**

At the top of `src/pages/ExpensesPage.tsx`, add (next to existing lucide-react imports):

```tsx
import { ExternalLink } from 'lucide-react'
import MerchantAvatar from '../components/MerchantAvatar'
```

(If `ExternalLink` is already in the existing import statement, just leave the merge alone.)

- [ ] **Step 2: Replace the merchant header inside `TransactionDetail`**

Find the existing merchant title rendering inside `TransactionDetail` (currently around lines 140-160, where merchant name is shown). Replace the merchant name block with:

```tsx
<div className="flex items-center gap-3">
  <MerchantAvatar logoUrl={tx.merchant_logo_url} merchant={tx.merchant ?? null} size={36} />
  <div className="min-w-0">
    <div className="flex items-center gap-2 flex-wrap">
      {tx.merchant_website ? (
        <a
          href={tx.merchant_website}
          target="_blank"
          rel="noopener noreferrer"
          className="text-base font-semibold text-gray-900 hover:underline inline-flex items-center gap-1"
        >
          {tx.merchant ?? '(no merchant)'}
          <ExternalLink size={12} className="text-gray-400" />
        </a>
      ) : (
        <span className="text-base font-semibold text-gray-900">
          {tx.merchant ?? '(no merchant)'}
        </span>
      )}
      {tx.pending && (
        <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
          Pending
        </span>
      )}
    </div>
    {tx.pending && (
      <div className="text-xs text-gray-500 mt-0.5">
        Will finalize within a few days.
      </div>
    )}
  </div>
</div>
```

- [ ] **Step 3: Replace the date row to support dual dates**

Find the existing date display inside `TransactionDetail` (the single line showing `tx.date`). Replace with:

```tsx
{(() => {
  const showDual =
    tx.authorized_date && tx.authorized_date !== tx.date
  const fmt = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  return showDual ? (
    <div className="text-sm text-gray-700">
      Purchased {fmt(tx.authorized_date!)} · Posted {fmt(tx.date)}
    </div>
  ) : (
    <div className="text-sm text-gray-700">{fmt(tx.date)}</div>
  )
})()}
```

- [ ] **Step 4: Add the "Details" group**

Below the notes textarea (find the existing `<Field label="Notes">...</Field>` or equivalent block) and before the existing "Plaid category" line, insert:

```tsx
{(() => {
  const channelLabel: Record<string, string> = {
    'online': 'Online',
    'in store': 'In store',
    'other': 'Other',
  }
  const locParts = [
    tx.location_city,
    tx.location_region,
    tx.location_store_number ? `Store #${tx.location_store_number}` : null,
  ].filter(Boolean)
  const showCurrency =
    tx.iso_currency_code && tx.iso_currency_code !== 'USD'

  const hasAny = tx.payment_channel || locParts.length > 0 || showCurrency
  if (!hasAny) return null

  return (
    <div className="border-t border-gray-100 pt-3 mt-3 space-y-2">
      {tx.payment_channel && (
        <div className="text-xs">
          <span className="text-gray-500 mr-2">Channel:</span>
          <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-medium">
            {channelLabel[tx.payment_channel as string] ?? tx.payment_channel}
          </span>
        </div>
      )}
      {locParts.length > 0 && (
        <div className="text-xs">
          <span className="text-gray-500 mr-2">Location:</span>
          <span className="text-gray-700">{locParts.join(' · ')}</span>
        </div>
      )}
      {showCurrency && (
        <div className="text-xs">
          <span className="text-gray-500 mr-2">Currency:</span>
          <span className="text-gray-700">{tx.iso_currency_code}</span>
        </div>
      )}
    </div>
  )
})()}
```

- [ ] **Step 5: Upgrade the "Plaid category" line with detailed + confidence**

Find the existing block (currently around `{tx.plaid_category && (...)}` near line 293). Replace with:

```tsx
{tx.plaid_category && (
  <div className="text-xs text-gray-500 mt-2">
    Plaid category:{' '}
    <span className="text-gray-600">
      {tx.plaid_category}
      {tx.plaid_category_detailed && ` / ${tx.plaid_category_detailed}`}
    </span>
    {tx.plaid_category_confidence && (
      <span
        className={`ml-2 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
          tx.plaid_category_confidence === 'VERY_HIGH' || tx.plaid_category_confidence === 'HIGH'
            ? 'bg-green-50 text-green-700'
            : tx.plaid_category_confidence === 'MEDIUM'
              ? 'bg-amber-50 text-amber-700'
              : 'bg-gray-100 text-gray-600'
        }`}
      >
        {tx.plaid_category_confidence.replace('_', ' ')}
      </span>
    )}
  </div>
)}
```

- [ ] **Step 6: Verify build + lint + tests**

```bash
npm run build 2>&1 | grep -E "error|✓ built" | tail -3
npm run lint 2>&1 | tail -3
npx vitest run 2>&1 | grep -E "Test Files|Tests" | head -3
```

Expected: build PASS, lint PASS (0 errors), 37/37 tests pass (no new tests added in this task).

- [ ] **Step 7: Commit**

```bash
git add src/pages/ExpensesPage.tsx
git commit -m "feat(plaid-metadata): surface logo/location/channel/pending in TransactionDetail"
```

---

## Task 7: Docs sweep — `docs/features/expenses.md` + `docs/features/settings.md`

**Files:**
- Modify: `docs/features/expenses.md`
- Modify: `docs/features/settings.md`

- [ ] **Step 1: Note new detail-panel fields in `expenses.md`**

Open `docs/features/expenses.md`. Find the section that describes the transaction detail slide-over (search for "detail" or "TransactionDetail"). Add a sub-bullet listing the new Plaid metadata fields:

```markdown
### Plaid metadata in the detail slide-over (added 2026-06-26)

When a transaction has `source = 'plaid'`, the slide-over surfaces:
- Merchant logo (via `MerchantAvatar` — falls back to initial circle if no `merchant_logo_url`).
- Merchant website link (when `merchant_website` is set; opens in a new tab).
- "Pending" amber pill (when `pending = true`).
- Dual dates: "Purchased X · Posted Y" when `authorized_date` differs from `date`.
- Payment channel pill, location row (city · region · store #), non-USD currency callout.
- Detailed PFC + confidence pill next to the existing primary PFC.

All fields render conditionally — manual / CSV / trade-source transactions show none of these.
```

- [ ] **Step 2: Add backfill note to `settings.md`**

Open `docs/features/settings.md`. Find the **Bank Connections** section, specifically the **Force Full Resync** bullet. Below the existing bullet, add:

```markdown
  - After the `plaid_metadata_capture` migration (2026-06-26), running Force Full Resync once per institution backfills merchant logos, locations, payment channel, and detailed PFC onto historical transactions. User edits (categories, notes, sale links, receipts) are not touched.
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/expenses.md docs/features/settings.md
git commit -m "docs(plaid-metadata): note new detail-panel fields + Force Full Resync backfill"
```

---

## Task 8: Manual E2E + push + PR

**Files:** none directly; coordination task.

- [ ] **Step 1: Run the full check suite**

```bash
npm run build 2>&1 | grep -E "error|✓ built" | tail -3
npm run lint 2>&1 | tail -3
npx vitest run 2>&1 | grep -E "Test Files|Tests" | head -3
```

Expected: build PASS, lint clean, 37/37 tests.

- [ ] **Step 2: Manual smoke (browser)**

`npm run dev`. Open `/expenses`. Pick a transaction with `source='plaid'`:
1. Confirm logo renders (or initial circle if Plaid didn't return one).
2. Click merchant name when underlined — should open merchant site in new tab.
3. If row is pending (rare for old rows), confirm amber "Pending" pill.
4. If any plaid row has `location_city` populated, confirm location row renders.
5. Confirm detailed PFC shows next to primary.

Then from `/settings`, run **Force Full Resync** on one connected institution. After it completes, return to `/expenses`, find a Plaid row whose `merchant_logo_url` was previously null — confirm it's now populated.

If any check fails, fix in place (file a new task on the branch), re-run the smoke before committing.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/plaid-metadata-capture
```

- [ ] **Step 4: Open PR via `gh` (or surface the URL)**

If `gh` is available:

```bash
gh pr create \
  --title "feat(plaid-metadata): capture + display rich Plaid fields" \
  --body-file <scratchpad>/pr-body.md
```

Otherwise, paste the title + body into the GitHub URL that `git push` printed.

Body template (write to scratchpad first):

```markdown
## Summary

Captures 14 additional fields from each Plaid transaction (logo, website, location, payment channel, pending flag, detailed PFC + confidence, currency, raw metadata jsonb) and surfaces the human-readable ones in the Expenses detail slide-over.

Sync code adds:
- A side-channel UPDATE pass that refreshes metadata on existing rows without touching user-set fields, so **Force Full Resync** backfills history cleanly.
- A pending → posted handoff that renames pending rows in place using `pending_transaction_id`, preserving user edits (notes, manually-set category, attached receipt, sale link).

Spec: `docs/superpowers/specs/2026-06-26-plaid-metadata-capture-design.md`
Plan: `docs/superpowers/plans/2026-06-26-plaid-metadata-capture.md`

## Notable changes

- Migration `plaid_metadata_capture` — 13 typed columns + `plaid_metadata jsonb`. `pending` defaults `false`, rest nullable.
- `plaid_sync_transactions` v39 deployed. iOS unaffected (additive).
- New `MerchantAvatar` component.

## Test plan

- [x] `npm run build` / `npm run lint` / 37 vitest
- [x] Manual smoke: Plaid detail panel shows logo, dates, location, channel, detailed PFC
- [x] Force Full Resync backfills historical rows; user-set categories survive

## Operational order

This PR depends on `feat/settings-and-plaid` being merged first (overlapping edits to `plaid_sync_transactions/index.ts`).
```

- [ ] **Step 5: Surface the PR URL to the user**

Output the PR URL in chat so the user can open it.

---

## Self-review checklist (run after the plan is written, before handoff)

- **Spec coverage:** every section in the spec ([`2026-06-26-plaid-metadata-capture-design.md`](../specs/2026-06-26-plaid-metadata-capture-design.md)) has a task that implements it:
  - Schema → Task 1.
  - Sync logic Change 1/2/3 → Task 3.
  - Backfill via Force Full Resync → Task 8 manual smoke.
  - Client types → Task 2.
  - UI → Task 5 + Task 6.
  - Tax-correctness invariants → preserved structurally by the SET-clause discipline in Task 3.
  - Files-touched table → Tasks 1, 3, 2, 5, 6, 7.
  - Operational checklist (merge order, migration, deploy, UI deploy, run Force Full Resync) → captured in Tasks 1, 4, 8.

- **Placeholder scan:** no "TBD" / "implement later" / vague directives. Every code-step has full code. Every command has expected output.

- **Type consistency:** `plaidMetadataFields` and `plaidRowFields` introduced in Task 3 Step 3; referenced in Task 3 Step 4 with matching names. `Transaction` interface fields in Task 2 match the column names from Task 1 and the JS keys built in Task 3 Step 2.

No gaps found.
