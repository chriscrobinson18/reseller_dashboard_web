# Plaid Orphan Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete duplicate Plaid transactions by comparing DB rows against Plaid's canonical transaction list via `/transactions/get`.

**Architecture:** Edge function pulls all transaction IDs from Plaid for each active item, compares against DB, returns orphaned rows. Client shows results in Settings Banks tab with a delete button.

**Tech Stack:** Deno edge function (Plaid SDK), React + React Query, Supabase JS client

---

### Task 1: Edge Function `find_plaid_orphans`

**Files:**
- Create: `supabase/functions/find_plaid_orphans/index.ts`

- [ ] **Step 1: Create the edge function**

```typescript
// find_plaid_orphans v1
// Pulls canonical transaction IDs from Plaid /transactions/get for each active
// plaid_item, compares against DB rows, and returns orphaned rows whose
// plaid_transaction_id doesn't exist in Plaid's response.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { Configuration, PlaidApi, PlaidEnvironments } from "npm:plaid@latest"

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

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing auth header')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Verify JWT and get user
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) throw new Error('Unauthorized')

    // Get all active plaid items for this user
    const { data: items, error: itemsErr } = await supabase
      .from('plaid_items')
      .select('id, item_id, access_token, institution_name, status')
      .eq('user_id', user.id)
    if (itemsErr) throw itemsErr

    const activeItems = (items ?? []).filter(i => !i.status || i.status === 'active')
    if (activeItems.length === 0) {
      return new Response(JSON.stringify({
        orphans: [],
        scanned_accounts: 0,
        total_plaid_transactions: 0,
        warnings: [],
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Get all plaid accounts for these items
    const { data: accounts, error: accErr } = await supabase
      .from('plaid_accounts')
      .select('account_id, item_id')
      .in('item_id', activeItems.map(i => i.item_id))
    if (accErr) throw accErr

    // Pull canonical transaction IDs from Plaid for each active item
    const canonicalIds = new Set<string>()
    const warnings: string[] = []
    const today = new Date().toISOString().split('T')[0]
    const twoYearsAgo = new Date(Date.now() - 730 * 86400000).toISOString().split('T')[0]

    for (const item of activeItems) {
      try {
        let offset = 0
        const PAGE_SIZE = 500
        let totalTx = 0

        // First call to get total_transactions
        const firstResp = await plaidClient.transactionsGet({
          access_token: item.access_token,
          start_date: twoYearsAgo,
          end_date: today,
          options: { count: PAGE_SIZE, offset: 0 },
        })

        totalTx = firstResp.data.total_transactions
        for (const tx of firstResp.data.transactions) {
          canonicalIds.add(tx.transaction_id)
        }
        offset = firstResp.data.transactions.length

        // Paginate remaining
        while (offset < totalTx) {
          const resp = await plaidClient.transactionsGet({
            access_token: item.access_token,
            start_date: twoYearsAgo,
            end_date: today,
            options: { count: PAGE_SIZE, offset },
          })
          for (const tx of resp.data.transactions) {
            canonicalIds.add(tx.transaction_id)
          }
          offset += resp.data.transactions.length
        }
      } catch (err) {
        warnings.push(`Failed to fetch from ${item.institution_name ?? item.item_id}: ${err.message}`)
      }
    }

    // Get all plaid-sourced DB transactions
    const accountIds = (accounts ?? []).map(a => a.account_id)
    const { data: dbRows, error: dbErr } = await supabase
      .from('transactions')
      .select('id, date, amount, merchant, account_display, plaid_transaction_id, schedule_c_category, notes, receipt_url, plaid_account_id')
      .eq('user_id', user.id)
      .eq('source', 'plaid')
      .not('plaid_transaction_id', 'is', null)
    if (dbErr) throw dbErr

    // Find orphans: DB rows whose plaid_transaction_id is not in Plaid's canonical set
    const orphans = (dbRows ?? []).filter(row => !canonicalIds.has(row.plaid_transaction_id))

    return new Response(JSON.stringify({
      orphans,
      scanned_accounts: accountIds.length,
      total_plaid_transactions: canonicalIds.size,
      warnings,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/find_plaid_orphans/index.ts
git commit -m "feat: add find_plaid_orphans edge function for dedup"
```

---

### Task 2: Client Mutation + Types

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/mutations.ts`

- [ ] **Step 1: Add types to `src/lib/types.ts`**

At the end of the file, add:

```typescript
// ── Plaid Dedup ──────────────────────────────────────────────────────────────

export interface OrphanedTransaction {
  id: string
  date: string
  amount: number
  merchant: string | null
  account_display: string | null
  plaid_transaction_id: string
  schedule_c_category: string | null
  notes: string | null
  receipt_url: string | null
  plaid_account_id: string | null
}

export interface FindOrphansResult {
  orphans: OrphanedTransaction[]
  scanned_accounts: number
  total_plaid_transactions: number
  warnings: string[]
}
```

- [ ] **Step 2: Add mutations to `src/lib/mutations.ts`**

At the end of the file, add:

```typescript
// ── Plaid Dedup ──────────────────────────────────────────────────────────────

export async function findPlaidOrphans(): Promise<FindOrphansResult> {
  const { data, error } = await supabase.functions.invoke('find_plaid_orphans')
  if (error) throw error
  return data as FindOrphansResult
}

export async function deleteDuplicateTransactions(ids: string[]): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .delete()
    .in('id', ids)
  if (error) throw error
}
```

Add the import at the top of `mutations.ts`:

```typescript
import type { FindOrphansResult } from './types'
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts src/lib/mutations.ts
git commit -m "feat: add findPlaidOrphans + deleteDuplicateTransactions mutations"
```

---

### Task 3: UI in Settings Banks Tab

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add dedup UI to SettingsPage.tsx**

Import the mutations:

```typescript
import { findPlaidOrphans, deleteDuplicateTransactions } from '../lib/mutations'
import type { FindOrphansResult } from '../lib/types'
import ConfirmDialog from '../components/ConfirmDialog'
```

Add state inside `SettingsPage`:

```typescript
const [dedupState, setDedupState] = useState<
  | { phase: 'idle' }
  | { phase: 'scanning' }
  | { phase: 'results'; data: FindOrphansResult }
  | { phase: 'deleting'; data: FindOrphansResult }
  | { phase: 'done'; deleted: number }
  | { phase: 'error'; message: string }
>({ phase: 'idle' })
const [showDedupConfirm, setShowDedupConfirm] = useState(false)
```

Add handlers:

```typescript
async function handleScanDuplicates() {
  setDedupState({ phase: 'scanning' })
  try {
    const data = await findPlaidOrphans()
    setDedupState({ phase: 'results', data })
  } catch (err: unknown) {
    setDedupState({ phase: 'error', message: err instanceof Error ? err.message : 'Scan failed' })
  }
}

async function handleDeleteOrphans() {
  if (dedupState.phase !== 'results') return
  const ids = dedupState.data.orphans.map(o => o.id)
  setDedupState({ phase: 'deleting', data: dedupState.data })
  setShowDedupConfirm(false)
  try {
    await deleteDuplicateTransactions(ids)
    qc.invalidateQueries({ queryKey: ['transactions'] })
    setDedupState({ phase: 'done', deleted: ids.length })
  } catch (err: unknown) {
    setDedupState({ phase: 'error', message: err instanceof Error ? err.message : 'Delete failed' })
  }
}
```

Add UI inside the `{activeTab === 'banks' && (...)}` block, after `<ShortcutsSettingsCard />`:

```tsx
{/* ── Duplicate Transaction Scan ─────────────────────── */}
<section className="space-y-3">
  <h2 className="text-lg font-semibold text-gray-900">Duplicate Transactions</h2>
  <div className="border border-gray-200 rounded-lg bg-white p-4 space-y-4">
    {dedupState.phase === 'idle' && (
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Scan for duplicate transactions from old Plaid connections.
        </p>
        <button
          onClick={handleScanDuplicates}
          className="px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-800"
        >
          Find Duplicates
        </button>
      </div>
    )}

    {dedupState.phase === 'scanning' && (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Scanning Plaid accounts for orphaned transactions...
      </div>
    )}

    {(dedupState.phase === 'results' || dedupState.phase === 'deleting') && (
      <>
        {dedupState.data.warnings.length > 0 && (
          <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
            {dedupState.data.warnings.map((w, i) => <p key={i}>{w}</p>)}
          </div>
        )}

        {dedupState.data.orphans.length === 0 ? (
          <p className="text-sm text-green-700">No duplicate transactions found.</p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-700">
                Found <span className="font-semibold text-red-600">{dedupState.data.orphans.length}</span> orphaned
                transactions (scanned {dedupState.data.total_plaid_transactions.toLocaleString()} Plaid records
                across {dedupState.data.scanned_accounts} accounts).
              </p>
              <button
                onClick={() => setShowDedupConfirm(true)}
                disabled={dedupState.phase === 'deleting'}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {dedupState.phase === 'deleting' ? 'Deleting...' : `Delete All ${dedupState.data.orphans.length}`}
              </button>
            </div>

            <div className="max-h-64 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded">
              {dedupState.data.orphans.map(o => (
                <div key={o.id} className="px-3 py-2 text-sm flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-gray-500 w-24 shrink-0">{o.date}</span>
                    <span className="font-medium text-gray-900 w-20 text-right shrink-0">
                      ${Math.abs(o.amount).toFixed(2)}
                    </span>
                    <span className="text-gray-700 truncate">{o.merchant ?? 'Unknown'}</span>
                  </div>
                  <span className="text-gray-400 text-xs shrink-0">{o.account_display ?? ''}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </>
    )}

    {dedupState.phase === 'done' && (
      <p className="text-sm text-green-700">
        Cleaned up {dedupState.deleted} duplicate transactions.
      </p>
    )}

    {dedupState.phase === 'error' && (
      <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between">
        <p>{dedupState.message}</p>
        <button onClick={() => setDedupState({ phase: 'idle' })} className="text-red-600 underline text-xs">
          Retry
        </button>
      </div>
    )}
  </div>
</section>

<ConfirmDialog
  open={showDedupConfirm}
  title="Delete Duplicate Transactions"
  message={`Permanently delete ${dedupState.phase === 'results' ? dedupState.data.orphans.length : 0} orphaned transactions? This cannot be undone.`}
  confirmLabel="Delete All"
  onConfirm={handleDeleteOrphans}
  onCancel={() => setShowDedupConfirm(false)}
  destructive
/>
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat: add duplicate transaction scanner to Settings Banks tab"
```

---

### Task 4: Deploy & Test

- [ ] **Step 1: Deploy the edge function**

```bash
supabase functions deploy find_plaid_orphans
```

- [ ] **Step 2: Manual test**

1. Open Settings > Banks tab
2. Click "Find Duplicates"
3. Verify orphaned transactions appear
4. Click "Delete All" → confirm
5. Re-scan to verify zero orphans

- [ ] **Step 3: Final commit with any fixes**
