# Plaid Duplicate Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Plaid reconnects from flooding the transactions table with duplicates by detecting duplicate accounts before exchanging a public token, prompting the user to keep or start fresh, and resetting item status on update-mode reconnects.

**Architecture:** `plaid_exchange_token` is rewritten to v17 with pre-exchange duplicate detection using stable Plaid `account_id`s from the `onSuccess` metadata. A new `transactions.plaid_account_id` column enables targeted deletion on "Start fresh" and precise grouping in the future review UI. The client shows a `DuplicateConnectionModal` when a duplicate is detected and sends the user's choice in a follow-up call.

**Tech Stack:** Deno/TypeScript (Supabase Edge Function), React 19, TanStack Query, Supabase JS, react-plaid-link, Tailwind v4, Vitest

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `supabase/migrations/20260825100000_transactions_plaid_account_id.sql` | Create | Add + backfill `plaid_account_id` column |
| `supabase/functions/plaid_exchange_token/index.ts` | Rewrite | v17: duplicate detection, keep/fresh, update-mode reset |
| `supabase/functions/plaid_sync_transactions/index.ts` | Modify | v34: populate `plaid_account_id` in `buildRow` |
| `src/lib/mutations.ts` | Modify | Extend `plaidExchangeToken` signature + return type |
| `src/components/modals/DuplicateConnectionModal.tsx` | Create | Keep / Start Fresh prompt |
| `src/pages/SettingsPage.tsx` | Modify | Handle `duplicate_detected`, state for pending token + modal |
| `docs/features/settings.md` | Modify | Document new reconnect behavior |
| `TASKS.md` | Modify | Close two P1 Plaid items on ship |

---

## Task 1: Migration — `transactions.plaid_account_id`

**Files:**
- Create: `supabase/migrations/20260825100000_transactions_plaid_account_id.sql`

- [ ] **Step 1: Write the migration**

```sql
-- plaid_account_id: stable Plaid account identifier on each transaction.
-- Plaid guarantees account_id is the same for the same physical account even
-- after an item reconnect, unlike plaid_transaction_id which changes per-item.
-- Used for targeted deletion in the "Start fresh" reconnect path and for
-- grouping in the duplicate review UI (Phase C).
alter table public.transactions
  add column plaid_account_id text;

-- Backfill from plaid_metadata JSONB already stored on every Plaid row.
-- account_id is a top-level field of the raw Plaid transaction object.
update public.transactions
  set plaid_account_id = plaid_metadata->>'account_id'
  where source = 'plaid'
    and plaid_metadata is not null
    and plaid_account_id is null;

create index transactions_plaid_account_id_idx
  on public.transactions(plaid_account_id)
  where plaid_account_id is not null;

comment on column public.transactions.plaid_account_id is
  'Stable Plaid account_id (same across item reconnects for the same physical card/account). '
  'Populated on insert by plaid_sync_transactions v34+; backfilled from plaid_metadata for historical rows. '
  'Used for targeted deletion when the user chooses Start Fresh on reconnect, '
  'and for grouping in the duplicate transaction review UI.';
```

- [ ] **Step 2: Apply the migration to Supabase**

In the Supabase MCP tool, call `apply_migration` with the SQL above. Or via CLI:
```bash
supabase db push
```

- [ ] **Step 3: Verify backfill**

Run this in the Supabase SQL editor (or MCP `execute_sql`):
```sql
select
  count(*) filter (where source = 'plaid' and plaid_metadata is not null) as plaid_rows,
  count(*) filter (where plaid_account_id is not null) as backfilled,
  count(*) filter (where source = 'plaid' and plaid_metadata is not null and plaid_account_id is null) as missed
from public.transactions;
```

Expected: `missed = 0` (all Plaid rows with metadata got the column). If `missed > 0`, those rows have null `plaid_metadata` — acceptable, they were created before v32 metadata capture and will be populated by the next Force Full Resync.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260825100000_transactions_plaid_account_id.sql
git commit -m "feat(schema): add transactions.plaid_account_id for Plaid dedup"
```

---

## Task 2: `plaid_sync_transactions` v34 — populate `plaid_account_id` in `buildRow`

**Files:**
- Modify: `supabase/functions/plaid_sync_transactions/index.ts`

- [ ] **Step 1: Add `plaid_account_id` to `buildRow`**

Find the `buildRow` function (around line 123). Add one field to the returned object, after `account_display`:

```typescript
// Before (existing line ~136):
account_display: accountMap[tx.account_id] ?? null,

// After — add the line immediately below it:
account_display: accountMap[tx.account_id] ?? null,
plaid_account_id: tx.account_id ?? null,
```

Also update the version comment at the top of the file:

```typescript
// plaid_sync_transactions v34
// v34: populate plaid_account_id on all new rows (tx.account_id, stable across
// item reconnects). Used by plaid_exchange_token v17's "Start fresh" deletion path
// and by the future duplicate review UI. No behavior change to sync logic.
```

The existing `plaidMetadataFields` and `plaidRowFields` functions both spread `buildRow`'s output and delete specific fields — `plaid_account_id` is not deleted by either, so it is automatically included in both the metadata refresh pass and the pending→posted rename path.

- [ ] **Step 2: Deploy the updated function**

```bash
supabase functions deploy plaid_sync_transactions
```

- [ ] **Step 3: Verify (manual)**

Trigger a Sync Now on any connected bank account from Settings. In the Supabase SQL editor:
```sql
select plaid_transaction_id, plaid_account_id, date, amount, merchant
from public.transactions
where source = 'plaid'
  and plaid_account_id is not null
order by created_at desc
limit 5;
```

Expected: newly-synced rows have `plaid_account_id` populated.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/plaid_sync_transactions/index.ts
git commit -m "feat(sync): v34 — populate plaid_account_id on new transaction rows"
```

---

## Task 3: `plaid_exchange_token` v17 — full rewrite

**Files:**
- Rewrite: `supabase/functions/plaid_exchange_token/index.ts`

This is a complete replacement of v16. The key changes:
- Reads `metadata`, `mode`, `choice`, `existing_item_id` from the request body
- **Update mode**: exchanges token, resets `plaid_items.status = 'active'`
- **Create mode, first call (no `choice`)**: detects duplicates via `account_id` before exchanging
- **Create mode, `choice = 'keep'`**: returns existing item info without exchanging
- **Create mode, `choice = 'fresh'`**: deletes old transactions + revokes old item, then exchanges
- Removes v16's institution-id-based auto-replace (replaced by user choice)

- [ ] **Step 1: Replace the file contents**

```typescript
// plaid_exchange_token v17
// v17: Plaid best-practices duplicate prevention (see docs/superpowers/specs/2026-08-25-plaid-dedup-design.md).
//
// CREATE MODE (default): Before exchanging, check if any incoming account_ids from the
// Plaid onSuccess metadata already exist in plaid_accounts for this user. If so, return
// { status: 'duplicate_detected' } without touching Plaid — the client shows a Keep/Fresh
// modal, then sends a second call with choice + existing_item_id.
//   keep  → discard public token, return existing item info (no exchange, no new item)
//   fresh → hard-delete old transactions by plaid_account_id, revoke old item, exchange new token
//
// UPDATE MODE (mode='update'): Skip duplicate detection. Exchange token to confirm re-auth
// with Plaid, then reset plaid_items.status='active' and clear error_message. Closes the P1
// gap where a successful update-mode reconnect left the badge stuck on "Reconnect needed".
//
// v16's institution-id-based auto-replace is removed. User choice replaces silent replacement.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { Configuration, PlaidApi, PlaidEnvironments, CountryCode } from "npm:plaid@latest"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[Deno.env.get('PLAID_ENV') || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': Deno.env.get('PLAID_CLIENT_ID'),
      'PLAID-SECRET': Deno.env.get('PLAID_SECRET'),
    },
  },
})

const plaidClient = new PlaidApi(plaidConfig)

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) return jsonResponse({ error: 'Unauthorized' }, 401)

    const body = await req.json()
    const {
      public_token,
      metadata,
      mode = 'create',
      item_id,
      choice,
      existing_item_id,
    } = body

    // ── UPDATE MODE ────────────────────────────────────────────────────────────
    // User completed Link update-mode to re-authenticate an existing item.
    // Exchange confirms re-auth with Plaid; access_token may rotate at some institutions.
    if (mode === 'update') {
      if (!public_token || !item_id) {
        return jsonResponse({ error: 'public_token and item_id required for update mode' }, 400)
      }
      const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token })
      const accessToken = exchangeResponse.data.access_token

      const { error: updateError } = await supabase
        .from('plaid_items')
        .update({ status: 'active', error_message: null, access_token: accessToken })
        .eq('item_id', item_id)
        .eq('user_id', user.id)
      if (updateError) throw new Error(`Failed to update item status: ${updateError.message}`)

      console.log('Update-mode reconnect: status reset to active for item', item_id)
      return jsonResponse({ success: true, status: 'reconnected' })
    }

    // ── CREATE MODE ────────────────────────────────────────────────────────────
    if (!public_token) return jsonResponse({ error: 'public_token required' }, 400)

    // Phase 1: Keep — return existing item info without exchanging the token.
    if (choice === 'keep') {
      if (!existing_item_id) return jsonResponse({ error: 'existing_item_id required' }, 400)
      const { data: existingItem } = await supabase
        .from('plaid_items')
        .select('status, institution_name')
        .eq('item_id', existing_item_id)
        .eq('user_id', user.id)
        .maybeSingle()

      const loginRequired = existingItem?.status === 'login_required'
      console.log('User chose Keep for existing item', existing_item_id)
      return jsonResponse({
        status: 'kept',
        institution_name: existingItem?.institution_name ?? null,
        ...(loginRequired ? {
          warning: 'login_required',
          message: 'Your existing connection needs re-authentication. Use the Reconnect button.',
        } : {}),
      })
    }

    // Phase 2: Fresh — delete old transactions, revoke old item, then fall through to exchange.
    if (choice === 'fresh') {
      if (!existing_item_id) return jsonResponse({ error: 'existing_item_id required' }, 400)

      // Collect old account_ids for targeted transaction deletion.
      const { data: oldAccounts } = await supabase
        .from('plaid_accounts')
        .select('account_id')
        .eq('item_id', existing_item_id)
        .eq('user_id', user.id)
      const oldAccountIds = (oldAccounts ?? []).map((a: any) => a.account_id)

      // Hard-delete — consistent with plaid_sync_transactions removal behavior (no soft-delete).
      if (oldAccountIds.length > 0) {
        const { error: delErr } = await supabase
          .from('transactions')
          .delete()
          .in('plaid_account_id', oldAccountIds)
          .eq('user_id', user.id)
        if (delErr) console.warn('Transaction deletion error (non-fatal):', delErr.message)
        console.log(`Deleted transactions for ${oldAccountIds.length} account(s) in item ${existing_item_id}`)
      }

      // Revoke the old Plaid item and remove its DB rows.
      const { data: oldItem } = await supabase
        .from('plaid_items')
        .select('access_token')
        .eq('item_id', existing_item_id)
        .eq('user_id', user.id)
        .maybeSingle()
      if (oldItem) {
        try {
          await plaidClient.itemRemove({ access_token: oldItem.access_token })
        } catch (removeErr: any) {
          console.warn('Could not revoke old Plaid item (non-fatal):', removeErr?.message)
        }
        await supabase.from('plaid_accounts').delete().eq('item_id', existing_item_id)
        await supabase.from('plaid_items').delete().eq('item_id', existing_item_id)
      }
      // Fall through to exchange + create new item below.
    }

    // Phase 0: First call (no choice yet) — pre-exchange duplicate detection.
    // account_id is stable across reconnects; if it already exists in plaid_accounts
    // for this user, this is a reconnect of an existing account, not a new connection.
    if (choice === undefined) {
      const incomingAccountIds: string[] = (metadata?.accounts ?? [])
        .map((a: any) => a.id)
        .filter(Boolean)

      if (incomingAccountIds.length > 0) {
        const { data: existingAccounts } = await supabase
          .from('plaid_accounts')
          .select('account_id, mask, item_id')
          .in('account_id', incomingAccountIds)
          .eq('user_id', user.id)

        if (existingAccounts && existingAccounts.length > 0) {
          const existingItemId = existingAccounts[0].item_id
          const { data: existingItem } = await supabase
            .from('plaid_items')
            .select('institution_name, status')
            .eq('item_id', existingItemId)
            .eq('user_id', user.id)
            .maybeSingle()

          console.log('Duplicate detected — account_ids already connected:', incomingAccountIds)
          return jsonResponse({
            status: 'duplicate_detected',
            existing_item_id: existingItemId,
            existing_institution_name:
              existingItem?.institution_name ?? metadata?.institution?.name ?? 'this institution',
            matched_masks: existingAccounts.map((a: any) => `••${a.mask}`),
            existing_item_status: existingItem?.status ?? 'active',
          })
        }
      }
      // No duplicate — fall through to exchange.
    }

    // ── EXCHANGE + CREATE NEW ITEM ─────────────────────────────────────────────
    // Reached when: no duplicate found (phase 0) OR user chose fresh (phase 2).
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token })
    const accessToken = exchangeResponse.data.access_token
    const itemId = exchangeResponse.data.item_id
    console.log('Token exchanged for item:', itemId)

    let institutionId: string | null = null
    let institutionName: string | null = null
    try {
      const itemResp = await plaidClient.itemGet({ access_token: accessToken })
      institutionId = itemResp.data.item.institution_id ?? null
      if (institutionId) {
        const instResp = await plaidClient.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
        })
        institutionName = instResp.data.institution.name
        console.log('Institution:', institutionName, institutionId)
      }
    } catch (instErr: any) {
      console.warn('Could not fetch institution info (non-fatal):', instErr?.message)
    }

    const { error: upsertError } = await supabase.from('plaid_items').upsert({
      user_id: user.id,
      item_id: itemId,
      access_token: accessToken,
      institution_id: institutionId,
      institution_name: institutionName,
      cursor: null,
      last_synced_at: null,
    }, { onConflict: 'item_id' })
    if (upsertError) throw new Error(`Failed to store item: ${upsertError.message}`)
    console.log('Item stored:', itemId)

    try {
      const acctResp = await plaidClient.accountsGet({ access_token: accessToken })
      for (const acct of acctResp.data.accounts) {
        const subtype = acct.subtype ?? acct.type ?? 'account'
        const displayName = `${subtype.charAt(0).toUpperCase() + subtype.slice(1)} ••${acct.mask}`
        await supabase.from('plaid_accounts').upsert({
          user_id: user.id,
          item_id: itemId,
          account_id: acct.account_id,
          name: acct.name,
          mask: acct.mask,
          subtype: acct.subtype ?? acct.type,
          display_name: displayName,
        }, { onConflict: 'account_id', ignoreDuplicates: false })
      }
      console.log(`Stored ${acctResp.data.accounts.length} accounts`)
    } catch (acctErr: any) {
      console.warn('Could not store accounts (non-fatal):', acctErr?.message)
    }

    return jsonResponse({
      success: true,
      institution_name: institutionName,
      note: 'Account connected. Transactions will sync automatically within 24 hours, or tap Sync Now in Settings.',
    })

  } catch (error: any) {
    console.error('Exchange token error:', error?.response?.data ?? error?.message)
    return jsonResponse({ error: error.message }, 500)
  }
})
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy plaid_exchange_token
```

- [ ] **Step 3: Smoke test update-mode path (manual)**

In Supabase Logs or the browser console, connect a bank in sandbox mode and confirm:
- First call returns `{ status: 'duplicate_detected', ... }` when the same account_ids exist
- No new `plaid_items` row is created until the user chooses Fresh

Then trigger a Reconnect on an existing `login_required` item in sandbox and confirm:
- Response is `{ success: true, status: 'reconnected' }`
- `plaid_items.status` is now `'active'` in the DB

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/plaid_exchange_token/index.ts
git commit -m "feat(plaid): exchange_token v17 — pre-exchange dedup + update-mode status reset

- Create mode: detect duplicate account_ids before exchanging public token;
  return duplicate_detected so client can prompt Keep or Start Fresh
- Keep: return existing item info, no token exchange
- Fresh: delete transactions by plaid_account_id, revoke old item, exchange new token
- Update mode: exchange token, reset plaid_items.status='active', clear error_message
- Remove v16's institution-id-based auto-replace (user choice replaces it)
Closes P1: Guard against duplicate connections re-importing history
Closes P1: Reset item status on update-mode reconnect"
```

---

## Task 4: `mutations.ts` — extend `plaidExchangeToken`

**Files:**
- Modify: `src/lib/mutations.ts` (around line 1775)

- [ ] **Step 1: Add the result type and extend the function**

Replace the existing `plaidExchangeToken` function (lines 1775–1783) with:

```typescript
export type PlaidExchangeResult =
  | {
      status: 'duplicate_detected'
      existing_item_id: string
      existing_institution_name: string
      matched_masks: string[]
      existing_item_status: 'active' | 'login_required' | 'error'
    }
  | {
      status: 'kept'
      institution_name: string | null
      warning?: 'login_required'
      message?: string
    }
  | {
      status: 'reconnected'
      success: true
    }
  | {
      success: true
      institution_name: string | null
      note?: string
    }

export async function plaidExchangeToken(params: {
  public_token: string
  metadata?: unknown
  mode?: 'create' | 'update'
  /** update mode: the existing plaid_items.item_id being re-authenticated */
  item_id?: string
  /** create mode, second call: user's choice after duplicate_detected */
  choice?: 'keep' | 'fresh'
  /** create mode, second call: the item_id to keep or replace */
  existing_item_id?: string
}): Promise<PlaidExchangeResult> {
  const { data, error } = await supabase.functions.invoke('plaid_exchange_token', {
    body: params,
  })
  if (error) throw error
  return (data ?? {}) as PlaidExchangeResult
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mutations.ts
git commit -m "feat(mutations): extend plaidExchangeToken for v17 modes and result types"
```

---

## Task 5: `DuplicateConnectionModal` component

**Files:**
- Create: `src/components/modals/DuplicateConnectionModal.tsx`

- [ ] **Step 1: Create the component**

```tsx
import Modal from '../Modal'
import type { PlaidExchangeResult } from '../../lib/mutations'

type DuplicateInfo = Extract<PlaidExchangeResult, { status: 'duplicate_detected' }>

interface Props {
  open: boolean
  info: DuplicateInfo | null
  onKeep: () => void
  onFresh: () => void
  onCancel: () => void
  isPending: boolean
}

export default function DuplicateConnectionModal({
  open, info, onKeep, onFresh, onCancel, isPending,
}: Props) {
  if (!info) return null

  return (
    <Modal open={open} onClose={onCancel} title="Account already connected">
      <div className="p-5 space-y-4">
        <p className="text-sm text-gray-700">
          <span className="font-medium">{info.existing_institution_name}</span> is already
          connected with account{info.matched_masks.length > 1 ? 's' : ''}{' '}
          <span className="font-mono font-medium">{info.matched_masks.join(', ')}</span>.
          What would you like to do?
        </p>

        {info.existing_item_status === 'login_required' && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            The existing connection needs re-authentication. If you choose Keep, use the
            Reconnect button to fix it.
          </div>
        )}

        <div className="space-y-2 pt-1">
          <button
            onClick={onKeep}
            disabled={isPending}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Keep existing transactions
          </button>
          <button
            onClick={onFresh}
            disabled={isPending}
            className="w-full rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            Start fresh — delete existing transactions
          </button>
          <button
            onClick={onCancel}
            disabled={isPending}
            className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>

        <p className="text-xs text-gray-400">
          Start fresh permanently deletes all synced transactions for the listed accounts
          and re-imports history from Plaid.
        </p>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 2: Verify no import errors**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/modals/DuplicateConnectionModal.tsx
git commit -m "feat(ui): DuplicateConnectionModal — Keep or Start Fresh on reconnect"
```

---

## Task 6: `SettingsPage` — wire up modal and mode routing

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

The existing page has `handleConnect` (create mode) and `handleReconnect` (update mode) but doesn't differentiate them in the exchange call, doesn't handle `duplicate_detected`, and doesn't show the modal.

- [ ] **Step 1: Replace `SettingsPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link'
import type { PlaidItem } from '../lib/types'
import {
  plaidCreateLinkToken,
  plaidExchangeToken,
  plaidSyncTransactions,
} from '../lib/mutations'
import type { PlaidExchangeResult } from '../lib/mutations'
import BankConnectionsSection from './settings/BankConnectionsSection'
import CustomCategoriesList from '../components/CustomCategoriesList'
import ShortcutsSettingsCard from '../components/ShortcutsSettingsCard'
import DuplicateConnectionModal from '../components/modals/DuplicateConnectionModal'

type DuplicateInfo = Extract<PlaidExchangeResult, { status: 'duplicate_detected' }>

export default function SettingsPage() {
  const qc = useQueryClient()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  // item_id of the item being reconnected in update mode (undefined = create mode)
  const [reconnectItemId, setReconnectItemId] = useState<string | undefined>()
  // Held across the duplicate modal — public_token has a 30-min Plaid expiry
  const [pendingPublicToken, setPendingPublicToken] = useState<string | null>(null)
  const [pendingMetadata, setPendingMetadata] = useState<PlaidLinkOnSuccessMetadata | null>(null)
  const [duplicateInfo, setDuplicateInfo] = useState<DuplicateInfo | null>(null)
  const plaidEnv = import.meta.env.VITE_PLAID_ENV as string | undefined

  function invalidatePlaid() {
    qc.invalidateQueries({ queryKey: ['plaid_items'] })
    qc.invalidateQueries({ queryKey: ['plaid_accounts'] })
    qc.invalidateQueries({ queryKey: ['transactions'] })
  }

  // First call: detect duplicates or exchange directly if no duplicate.
  const exchangeTokenMutation = useMutation({
    mutationFn: (params: Parameters<typeof plaidExchangeToken>[0]) =>
      plaidExchangeToken(params),
    onSuccess: (result) => {
      if (result.status === 'duplicate_detected') {
        // Hold here — client shows modal, sends follow-up choice call.
        setDuplicateInfo(result)
        return
      }
      if ('warning' in result && result.warning === 'login_required') {
        setLinkError(
          'Existing connection needs re-authentication — use the Reconnect button.'
        )
      }
      invalidatePlaid()
      setReconnectItemId(undefined)
    },
    onError: (e: Error) => setLinkError(e.message),
  })

  // Second call: user's keep/fresh choice after duplicate detected.
  const choiceMutation = useMutation({
    mutationFn: (choice: 'keep' | 'fresh') =>
      plaidExchangeToken({
        public_token: pendingPublicToken!,
        metadata: pendingMetadata,
        mode: 'create',
        choice,
        existing_item_id: duplicateInfo!.existing_item_id,
      }),
    onSuccess: (result, choice) => {
      // Capture before clearing state
      const keptItemId = duplicateInfo?.existing_item_id
      setDuplicateInfo(null)
      setPendingPublicToken(null)
      setPendingMetadata(null)

      if ('warning' in result && result.warning === 'login_required') {
        setLinkError(
          'Existing connection needs re-authentication — use the Reconnect button.'
        )
      }
      // Trigger sync on kept item so new transactions appear without manual Sync Now.
      if (choice === 'keep' && keptItemId) {
        plaidSyncTransactions({ item_id: keptItemId }).catch(() => {})
      }
      invalidatePlaid()
    },
    onError: (e: Error) => {
      setLinkError(e.message)
      setDuplicateInfo(null)
      setPendingPublicToken(null)
      setPendingMetadata(null)
    },
  })

  const createTokenMutation = useMutation({
    mutationFn: (itemId?: string) => plaidCreateLinkToken(itemId),
    onSuccess: ({ link_token }) => setLinkToken(link_token),
    onError: (e: Error) => setLinkError(e.message),
  })

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (public_token, metadata) => {
      setLinkToken(null)
      if (reconnectItemId) {
        // Update mode — re-authenticating an existing item; skip duplicate detection.
        exchangeTokenMutation.mutate({
          public_token,
          mode: 'update',
          item_id: reconnectItemId,
        })
        setReconnectItemId(undefined)
      } else {
        // Create mode — check for duplicates before exchanging.
        setPendingPublicToken(public_token)
        setPendingMetadata(metadata)
        exchangeTokenMutation.mutate({ public_token, metadata, mode: 'create' })
      }
    },
    onExit: (err) => {
      if (err)
        setLinkError(
          `Plaid Link closed with an error: ${err.error_message ?? err.error_code}`
        )
      setLinkToken(null)
    },
  })

  useEffect(() => {
    if (linkToken && ready) open()
  }, [linkToken, ready, open])

  function handleConnect() {
    setLinkError(null)
    setReconnectItemId(undefined)
    createTokenMutation.mutate(undefined)
  }

  function handleReconnect(item: PlaidItem) {
    setLinkError(null)
    setReconnectItemId(item.item_id)
    createTokenMutation.mutate(item.item_id)
  }

  const busy =
    createTokenMutation.isPending ||
    exchangeTokenMutation.isPending ||
    choiceMutation.isPending

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-10">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage bank connections and custom categories
        </p>
      </header>

      <BankConnectionsSection
        onConnect={handleConnect}
        onReconnect={handleReconnect}
        errorMessage={linkError}
        busy={busy}
      />

      <section className="space-y-3">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Custom Categories</h2>
        </header>
        <div className="border border-gray-200 rounded-lg bg-white p-4">
          <CustomCategoriesList />
        </div>
      </section>

      <ShortcutsSettingsCard />

      {plaidEnv && plaidEnv !== 'production' && (
        <div className="text-xs text-gray-400 text-center pt-6">
          Plaid env: {plaidEnv}
        </div>
      )}

      <DuplicateConnectionModal
        open={duplicateInfo !== null}
        info={duplicateInfo}
        onKeep={() => choiceMutation.mutate('keep')}
        onFresh={() => choiceMutation.mutate('fresh')}
        onCancel={() => {
          setDuplicateInfo(null)
          setPendingPublicToken(null)
          setPendingMetadata(null)
        }}
        isPending={choiceMutation.isPending}
      />
    </div>
  )
}
```

- [ ] **Step 2: Verify it builds**

```bash
npm run build
```

Expected: no TypeScript errors. Note: `item_id` on `PlaidItem` is the Plaid item_id string (not the DB `id` UUID) — confirm by checking `src/lib/types.ts` line 233.

- [ ] **Step 3: Manual test in sandbox**

Run `npm run dev`. Go to Settings → Connect Bank. Use Plaid sandbox credentials to connect an account that's already connected. Confirm:
- Modal appears with institution name and account masks
- Keep: modal dismisses, Sync Now fires, no new item in the bank connections list
- Fresh: modal dismisses, old transactions gone, new sync appears, new item in list
- Cancel: modal dismisses, no changes

- [ ] **Step 4: Manual test update-mode path**

In sandbox, set an item to `login_required` directly via SQL:
```sql
update plaid_items set status = 'login_required' where institution_name = 'Chase';
```
Then click Reconnect for that item. After completing Link, confirm `status` is back to `'active'`:
```sql
select status from plaid_items where institution_name = 'Chase';
```
Expected: `active`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat(settings): handle duplicate_detected + keep/fresh modal, update-mode mode param"
```

---

## Task 7: Existing data repair — verify backfill + re-sync

This task is operational, not code. Run after Tasks 1–6 are deployed.

- [ ] **Step 1: Verify `plaid_account_id` backfill coverage**

```sql
select
  count(*) filter (where source = 'plaid')                     as total_plaid,
  count(*) filter (where source = 'plaid' and plaid_account_id is not null) as has_account_id,
  count(*) filter (where source = 'plaid' and plaid_account_id is null
                   and plaid_metadata is not null)              as missing_backfill
from public.transactions;
```

Expected: `missing_backfill = 0`. If non-zero, re-run the backfill UPDATE from Task 1 manually.

- [ ] **Step 2: Re-sync affected cards**

In Settings, locate the institutions for cards ••1000, ••1004, ••2003 (AmEx and Chase accounts involved in the July reconnects). For each, open the kebab menu → Force Full Resync.

This re-delivers all historical `plaid_transaction_id`s from the current item. Since these are the same items (not new items), Plaid returns the same IDs. The existing `ignoreDuplicates: true` guard skips rows already in the DB and re-inserts any rows that were accidentally deleted during the July cleanup.

New rows from this sync will have `plaid_account_id` populated (Task 2 is deployed).

- [ ] **Step 3: Check for net-new rows**

After resync completes, look for any newly-inserted rows:
```sql
select count(*), min(date), max(date)
from public.transactions
where source = 'plaid'
  and created_at > now() - interval '1 hour';
```

If rows appear, they were previously missing (accidentally deleted). Review them in the Expenses page and categorize as needed.

- [ ] **Step 4: Note remaining ambiguous dupes**

The ~441 ambiguous groups (repeat purchases that can't be auto-distinguished from re-import dupes) are NOT addressed here. They are tracked in TASKS.md P0 and will be handled by the Phase C review UI (separate spec). No action needed now.

---

## Task 8: Docs + TASKS.md

**Files:**
- Modify: `docs/features/settings.md`
- Modify: `TASKS.md`

- [ ] **Step 1: Update `docs/features/settings.md`**

In the "Bank Connections" section, add under the "Connect Bank" bullet:

```markdown
- **Duplicate detection** — if the accounts being connected share a Plaid `account_id`
  with an existing connection, the exchange is paused and the user is prompted to
  **Keep existing transactions** (existing connection preserved, a sync is triggered)
  or **Start fresh** (old transactions deleted, new item created). Implemented in
  `plaid_exchange_token` v17. See [`docs/superpowers/specs/2026-08-25-plaid-dedup-design.md`].
```

Update the "Reconnect" bullet:

```markdown
- **Reconnect** — appears as a red button when `plaid_items.status = 'login_required'`.
  Launches Plaid Link in update mode (passes `item_id` to `plaid_create_link_token`).
  On success, `plaid_exchange_token` v17 resets `plaid_items.status = 'active'`
  immediately — the badge clears without waiting for the next sync.
```

In the "Backend dependencies" section, remove or update the known gap entry for status reset, marking it resolved in v17.

- [ ] **Step 2: Update `TASKS.md`**

Mark both P1 Plaid items closed:

```markdown
- [x] **`plaid_exchange_token`: reset item status on update-mode reconnect** — _Closed
  by `plaid_exchange_token` v17_: update mode now exchanges token and writes
  `plaid_items.status = 'active'` immediately on success.
- [x] **Guard against duplicate connections re-importing history** — _Closed by
  `plaid_exchange_token` v17_: pre-exchange account_id detection prevents new items
  from being created for existing accounts; Keep/Fresh modal gives user control.
  `transactions.plaid_account_id` column enables targeted deletion on Fresh.
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/settings.md TASKS.md
git commit -m "docs: close P1 Plaid items — v17 dedup + status reset shipped"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `transactions.plaid_account_id` column + backfill + index | Task 1 |
| `buildRow` in sync populates `plaid_account_id` | Task 2 |
| `plaid_exchange_token` v17 update-mode status reset | Task 3 |
| Create-mode pre-exchange duplicate detection via `account_id` | Task 3 |
| `duplicate_detected` response shape | Task 3 |
| Keep path — no exchange, return existing item info | Task 3 |
| Fresh path — delete by `plaid_account_id`, revoke old item, exchange | Task 3 |
| Edge case: keep + `login_required` → warning in response | Task 3 |
| `plaidExchangeToken` mutation extended signature + result type | Task 4 |
| `DuplicateConnectionModal` component | Task 5 |
| `SettingsPage` create-mode vs update-mode routing | Task 6 |
| `SettingsPage` `duplicate_detected` handling + state | Task 6 |
| Auto-sync on Keep | Task 6 |
| Existing data repair — backfill + re-sync | Task 7 |
| Docs + TASKS.md closure | Task 8 |

All spec requirements covered. No placeholders. Types defined in Task 4 are used consistently in Tasks 5 and 6.
