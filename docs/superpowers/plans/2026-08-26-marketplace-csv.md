# Marketplace CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add eBay/Amazon/Mercari CSV import, a `sync_csv_orders_to_sales` edge function that creates Sales rows from imported transactions, and a Settlement Status UI that lets users match settlement groups to Plaid bank deposits — all inside SettingsPage.

**Architecture:** The existing `import_marketplace_csv` edge function (v16) handles parsing + inserting transactions. A new `sync_csv_orders_to_sales` edge function groups those transactions by order ref (the `notes` field) and upserts `sales` rows. The Settlement Status UI reads the same `csv_import` transactions grouped client-side by `csv_group_id` and lets users link each group to a matching Plaid transaction.

**Tech Stack:** Deno/TypeScript (edge function), React 19 + TypeScript, TanStack React Query, Tailwind v4, `@supabase/supabase-js`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/types.ts` | Modify | Add CSVImportResult, CSVSaleSyncResult, CSVGroup; add `csv_group_id` to Transaction; add `null` to Sale.return_status |
| `src/lib/queries.ts` | Modify | Add buildCSVGroups, 8 helper functions, useCSVGroups |
| `src/lib/mutations.ts` | Modify | Add importMarketplaceCSV, syncCSVOrders, markTransactionAsSettlement, linkCSVGroupToSettlement, unlinkCSVGroup |
| `supabase/functions/sync_csv_orders_to_sales/index.ts` | Create | Edge function: group csv_import transactions → upsert sales rows |
| `src/components/CSVGroupDetailSlideOver.tsx` | Create | Settlement group detail: summary, bank match, transaction list |
| `src/pages/SettingsPage.tsx` | Modify | Add CSV Import section + Settlement Status section |
| `docs/features/settings.md` | Modify | Document new sections |
| `TASKS.md` | Modify | Close CSV Import, Settlement Status, CSV→Sales items |

---

## Task 1: Types

**Files:**
- Modify: `src/lib/types.ts`

Read the file first (`src/lib/types.ts`) to see the current Transaction and Sale interfaces before editing.

- [ ] **Step 1: Add `csv_group_id` to Transaction, update Sale.return_status, add 3 new types**

In `src/lib/types.ts`, make these three additions:

**1a. Add `csv_group_id` to Transaction** (it's the only missing CSV field — `csv_transaction_id` and `parent_settlement_id` already exist):

Find the line with `csv_transaction_id?: string` and add `csv_group_id` on the line before it:
```typescript
  csv_group_id?: string | null
  csv_transaction_id?: string | null
```

**1b. Update Sale.return_status** to accept `null` (DB constraint is `null | 'partial' | 'full'`; the existing `'none'` value is wrong):

Find: `return_status: 'none' | 'partial' | 'full'`
Replace with: `return_status: null | 'none' | 'partial' | 'full'`

(Keep `'none'` in the union for backward compat with any existing display code that checks for it; add `null` so new CSV-synced sales with no return are typed correctly.)

**1c. Add three new types** at the end of `src/lib/types.ts`, before any closing export:

```typescript
export type CSVImportResult = {
  platform: string
  rows_parsed: number
  rows_skipped: number
  skipped_breakdown?: Record<string, number>
  amazon_format?: string  // 'transaction_view' | 'settlement_report'
}

export type CSVSaleSyncResult = {
  created: number
  updated: number
  removed: number
}

export interface CSVGroup {
  groupId: string
  platform: string
  transactions: Transaction[]
  /** Closing reserve carried forward from the previous group. Computed by buildCSVGroups. */
  priorBalance: number
}
```

- [ ] **Step 2: Build check**

```bash
npm run build 2>&1 | tail -20
```

Expected: no TypeScript errors. If `return_status` usages break, find them with `grep -rn "return_status.*none\|=== 'none'" src/` and handle each (they should still work since `'none'` remains in the union).

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(csv): add CSVGroup, CSVImportResult, CSVSaleSyncResult types; add csv_group_id to Transaction"
```

---

## Task 2: Queries — buildCSVGroups + helper functions + useCSVGroups

**Files:**
- Modify: `src/lib/queries.ts`

Read `src/lib/queries.ts` first to see the existing imports and end of file.

- [ ] **Step 1: Add CSV group helpers and useCSVGroups to queries.ts**

Append the following to the end of `src/lib/queries.ts`:

```typescript
// ─── CSV Group helpers ────────────────────────────────────────────────────────

const SKIP_CATEGORIES = new Set([
  'transfer', 'balance_adjustment', 'taxes_licenses', 'settlement',
])

export function getTransferRow(g: CSVGroup): Transaction | undefined {
  return g.transactions.find(tx => tx.schedule_c_category === 'transfer')
}

export function getNonTransferRows(g: CSVGroup): Transaction[] {
  return g.transactions.filter(tx => tx.schedule_c_category !== 'transfer')
}

export function getExpectedDeposit(g: CSVGroup): number | undefined {
  const t = getTransferRow(g)
  return t !== undefined ? -t.amount : undefined
}

export function isLinkedGroup(g: CSVGroup): boolean {
  return g.transactions.some(tx => tx.parent_settlement_id != null)
}

export function getLinkedSettlementId(g: CSVGroup): string | undefined {
  return g.transactions.find(tx => tx.parent_settlement_id != null)?.parent_settlement_id ?? undefined
}

export function getNetTotal(g: CSVGroup): number {
  return getNonTransferRows(g).reduce((sum, tx) => sum + tx.amount, 0)
}

export function getAdjustedTotal(g: CSVGroup): number {
  return getNetTotal(g) + g.priorBalance
}

export function getClosingReserve(g: CSVGroup): number | undefined {
  const expected = getExpectedDeposit(g)
  return expected !== undefined ? getAdjustedTotal(g) - expected : undefined
}

export function buildCSVGroups(rows: Transaction[], platform: string): CSVGroup[] {
  // 1. Group rows by csv_group_id
  const map = new Map<string, Transaction[]>()
  for (const tx of rows) {
    if (!tx.csv_group_id) continue
    const arr = map.get(tx.csv_group_id) ?? []
    arr.push(tx)
    map.set(tx.csv_group_id, arr)
  }

  // 2. Build groups; sort oldest-first so we can propagate the balance chain
  const groups: CSVGroup[] = [...map.entries()].map(([groupId, transactions]) => ({
    groupId, platform, transactions, priorBalance: 0,
  }))
  groups.sort((a, b) => {
    const aDate = getTransferRow(a)?.date ?? a.transactions[0]?.date ?? ''
    const bDate = getTransferRow(b)?.date ?? b.transactions[0]?.date ?? ''
    return aDate.localeCompare(bDate)
  })

  // 3. Propagate closing reserve as priorBalance into the next group
  let carry = 0
  for (const g of groups) {
    g.priorBalance = carry
    carry = getClosingReserve(g) ?? 0
  }

  // 4. Return newest-first for display
  return groups.reverse()
}

export function useCSVGroups(platform: string) {
  return useQuery({
    queryKey: ['csv-groups', platform],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('source', 'csv_import')
        .eq('platform', platform)
        .not('csv_group_id', 'is', null)
        .order('date', { ascending: false })
      if (error) throw error
      return buildCSVGroups((data ?? []) as Transaction[], platform)
    },
  })
}
```

Also add the necessary imports at the top of `queries.ts` if not already present — `CSVGroup` and `Transaction` from `'./types'`:

```typescript
import type { ..., CSVGroup } from './types'
```

Check the existing import line and add `CSVGroup` to it.

- [ ] **Step 2: Build check**

```bash
npm run build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/queries.ts
git commit -m "feat(csv): add buildCSVGroups, CSV group helpers, useCSVGroups"
```

---

## Task 3: Mutations — 5 new functions

**Files:**
- Modify: `src/lib/mutations.ts`

Read the end of `src/lib/mutations.ts` to see where to append.

- [ ] **Step 1: Add 5 CSV mutations to mutations.ts**

Append after the last exported function in `src/lib/mutations.ts`:

```typescript
// ─── CSV Import / Settlement ──────────────────────────────────────────────────

export async function importMarketplaceCSV(
  platform: string,
  file: File,
): Promise<CSVImportResult> {
  const csvText = await file.text()
  const { data, error } = await supabase.functions.invoke('import_marketplace_csv', {
    body: { platform, csv_text: csvText },
  })
  if (error) throw error
  return data as CSVImportResult
}

export async function syncCSVOrders(platform: string): Promise<CSVSaleSyncResult> {
  const { data, error } = await supabase.functions.invoke('sync_csv_orders_to_sales', {
    body: { platform },
  })
  if (error) throw error
  return data as CSVSaleSyncResult
}

export async function markTransactionAsSettlement(
  id: string,
  platform: string,
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ record_type: 'settlement', schedule_c_category: 'settlement', platform })
    .eq('id', id)
  if (error) throw error
}

export async function linkCSVGroupToSettlement(
  groupId: string,
  settlementId: string,
  platform: string,
): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ parent_settlement_id: settlementId })
    .eq('source', 'csv_import')
    .eq('platform', platform)
    .eq('csv_group_id', groupId)
  if (error) throw error
}

export async function unlinkCSVGroup(groupId: string, platform: string): Promise<void> {
  const { error } = await supabase
    .from('transactions')
    .update({ parent_settlement_id: null })
    .eq('source', 'csv_import')
    .eq('platform', platform)
    .eq('csv_group_id', groupId)
  if (error) throw error
}
```

Also add the new types to the import at the top of `mutations.ts`:

```typescript
import type { ..., CSVImportResult, CSVSaleSyncResult } from './types'
```

- [ ] **Step 2: Build check**

```bash
npm run build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mutations.ts
git commit -m "feat(csv): add importMarketplaceCSV, syncCSVOrders, settlement link/unlink mutations"
```

---

## Task 4: Edge Function — `sync_csv_orders_to_sales`

**Files:**
- Create: `supabase/functions/sync_csv_orders_to_sales/index.ts`

- [ ] **Step 1: Create the edge function directory and file**

```bash
mkdir -p /Users/user/Developer/reseller_dashboard_web/supabase/functions/sync_csv_orders_to_sales
```

- [ ] **Step 2: Write the edge function**

Create `supabase/functions/sync_csv_orders_to_sales/index.ts`:

```typescript
// sync_csv_orders_to_sales v1
// Groups csv_import transactions by order ref (notes field) and upserts
// unlinked sales rows. Fixes three mobile bugs:
//   1. shipping_postage rows were unreachable dead code — now included
//   2. duplicate external_order_id crashed mobile — safe Map used here
//   3. return_status used invalid 'none' — writes null per DB constraint
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

const SKIP_CATEGORIES = new Set([
  "transfer", "balance_adjustment", "taxes_licenses", "settlement",
])

// Map platform string to the sales.source value allowed by the DB constraint:
//   'manual' | 'amazon' | 'ebay' | 'tcgplayer' | 'csv_import' | 'trade'
// Mercari has no dedicated source value — use 'csv_import'.
function sourceForPlatform(platform: string): string {
  if (platform === "ebay" || platform === "amazon") return platform
  return "csv_import"
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) return json(401, { error: "Unauthorized" })

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return json(401, { error: "Unauthorized" })

    const body = await req.json()
    const platform: string = body.platform
    if (!platform) return json(400, { error: "Missing platform" })

    // ── 1. Fetch all csv_import transactions for this user + platform ─────────
    const { data: rows, error: fetchErr } = await supabase
      .from("transactions")
      .select("id, date, amount, merchant, notes, schedule_c_category, csv_group_id")
      .eq("user_id", user.id)
      .eq("source", "csv_import")
      .eq("platform", platform)
      .not("csv_group_id", "is", null)
      .order("date", { ascending: true })

    if (fetchErr) return json(500, { error: fetchErr.message })

    // ── 2. Group by orderRef (notes field) ────────────────────────────────────
    interface OrderEntry {
      grossRevenue: number
      refundedAmount: number
      fees: number
      shippingCost: number
      date: string
      productName: string | null
    }

    const orderMap = new Map<string, OrderEntry>()

    for (const tx of (rows ?? [])) {
      const ref = tx.notes as string | null
      if (!ref || ref === "" || ref === "--") continue
      if (SKIP_CATEGORIES.has(tx.schedule_c_category as string)) continue

      const entry: OrderEntry = orderMap.get(ref) ?? {
        grossRevenue: 0, refundedAmount: 0, fees: 0,
        shippingCost: 0, date: tx.date, productName: null,
      }

      const amount = Number(tx.amount)
      const cat = tx.schedule_c_category as string

      if (cat === "payout") {
        if (amount > 0) {
          entry.grossRevenue += amount
          // Keep the earliest payout date as the sale date
          if (tx.date < entry.date) entry.date = tx.date
          if (!entry.productName && tx.merchant) entry.productName = tx.merchant
        } else {
          entry.refundedAmount += Math.abs(amount)
        }
      } else if (cat === "commissions_fees") {
        entry.fees += Math.abs(amount)
      } else if (cat === "shipping_postage") {
        entry.shippingCost += Math.abs(amount)
      }

      orderMap.set(ref, entry)
    }

    // ── 3. Keep only orders with gross revenue ────────────────────────────────
    const ordersToSync = new Map<string, OrderEntry>()
    for (const [ref, entry] of orderMap) {
      if (entry.grossRevenue > 0) ordersToSync.set(ref, entry)
    }

    if (ordersToSync.size === 0) {
      return json(200, { created: 0, updated: 0, removed: 0 })
    }

    // ── 4. Fetch existing csv-sourced sales for this platform ─────────────────
    const source = sourceForPlatform(platform)
    const { data: existingSales, error: salesErr } = await supabase
      .from("sales")
      .select("id, external_order_id, deleted_at")
      .eq("user_id", user.id)
      .eq("source", source)
      .eq("platform", platform)
      .not("external_order_id", "is", null)

    if (salesErr) return json(500, { error: salesErr.message })

    // Build a safe Map (no crash on duplicate external_order_id)
    const existingMap = new Map<string, { id: string; deleted_at: string | null }>()
    for (const s of (existingSales ?? [])) {
      if (s.external_order_id && !existingMap.has(s.external_order_id)) {
        existingMap.set(s.external_order_id, { id: s.id, deleted_at: s.deleted_at })
      }
    }

    // ── 5. Upsert ─────────────────────────────────────────────────────────────
    let created = 0, updated = 0, removed = 0

    for (const [ref, entry] of ordersToSync) {
      const salePrice = entry.grossRevenue - entry.refundedAmount
      const netPayout = salePrice - entry.fees - entry.shippingCost
      const returnStatus =
        entry.refundedAmount === 0 ? null
        : entry.refundedAmount >= entry.grossRevenue ? "full"
        : "partial"

      const saleData = {
        sale_price: salePrice,
        fees: entry.fees,
        shipping_cost: entry.shippingCost,
        net_payout: netPayout,
        return_status: returnStatus,
        date: entry.date,
      }

      const existing = existingMap.get(ref)
      if (existing) {
        // Update (and restore if soft-deleted)
        const updatePayload: Record<string, unknown> = { ...saleData }
        if (existing.deleted_at !== null) updatePayload.deleted_at = null
        const { error } = await supabase
          .from("sales")
          .update(updatePayload)
          .eq("id", existing.id)
        if (error) console.error("Update error:", error.message)
        else updated++
      } else {
        // Insert
        const { error } = await supabase.from("sales").insert({
          user_id: user.id,
          platform,
          source,
          external_order_id: ref,
          item_id: null,
          item_name: entry.productName ?? null,
          quantity: 1,
          ...saleData,
        })
        if (error) console.error("Insert error:", error.message)
        else created++
      }
    }

    // ── 6. Soft-delete orphans (order no longer in CSV) ───────────────────────
    for (const [ref, existing] of existingMap) {
      if (!ordersToSync.has(ref) && existing.deleted_at === null) {
        const { error } = await supabase
          .from("sales")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", existing.id)
        if (error) console.error("Soft-delete error:", error.message)
        else removed++
      }
    }

    return json(200, { created, updated, removed })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return json(500, { error: msg })
  }
})
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/sync_csv_orders_to_sales/
git commit -m "feat(csv): add sync_csv_orders_to_sales edge function v1"
```

---

## Task 5: Deploy Edge Function

- [ ] **Step 1: Deploy**

```bash
npx supabase functions deploy sync_csv_orders_to_sales --project-ref $SUPABASE_PROJECT_REF
```

If `SUPABASE_PROJECT_REF` is not set, find it in `.env` or `vercel.json`:
```bash
grep -r 'supabase\|project' .env vercel.json 2>/dev/null | head -10
```

- [ ] **Step 2: Smoke test via curl**

```bash
# Get your anon key
ANON_KEY=$(grep VITE_SUPABASE_ANON_KEY .env | cut -d= -f2)
PROJECT_REF=<your-project-ref>

curl -s -X POST \
  "https://${PROJECT_REF}.supabase.co/functions/v1/sync_csv_orders_to_sales" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"platform":"ebay"}' | jq .
```

Expected (with no CSV data imported yet): `{"created":0,"updated":0,"removed":0}`
Expected (with existing data): `{"created":N,"updated":M,"removed":0}`

- [ ] **Step 3: Commit deployment note**

```bash
git commit --allow-empty -m "chore: deploy sync_csv_orders_to_sales v1"
```

---

## Task 6: CSVGroupDetailSlideOver Component

**Files:**
- Create: `src/components/CSVGroupDetailSlideOver.tsx`

Read `src/components/SlideOver.tsx` to see the exact Props interface before implementing.

Also read `src/lib/mutations.ts` lines around `insertTransaction` (line ~615) to see its exact signature.

- [ ] **Step 1: Create the component**

Create `src/components/CSVGroupDetailSlideOver.tsx`:

```typescript
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import SlideOver from './SlideOver'
import {
  getTransferRow, getNonTransferRows, getExpectedDeposit,
  isLinkedGroup, getLinkedSettlementId,
  getNetTotal, getAdjustedTotal, getClosingReserve,
} from '../lib/queries'
import {
  markTransactionAsSettlement, linkCSVGroupToSettlement,
  unlinkCSVGroup, insertTransaction,
} from '../lib/mutations'
import { supabase } from '../lib/supabase'
import type { CSVGroup, Transaction } from '../lib/types'

type Props = {
  group: CSVGroup
  platform: string
  open: boolean
  onClose: () => void
  onLinked: () => void
}

const CATEGORY_LABELS: Record<string, string> = {
  payout: 'Revenue',
  commissions_fees: 'Fees',
  shipping_postage: 'Shipping',
  advertising: 'Advertising',
  other_expense: 'Other',
  balance_adjustment: 'Adjustment',
  taxes_licenses: 'Tax Withheld',
  transfer: 'Payout',
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtUSD(n: number) {
  const abs = Math.abs(n)
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `−$${str}` : `$${str}`
}

function platformDisplayName(p: string) {
  if (p === 'ebay') return 'eBay'
  if (p === 'amazon') return 'Amazon'
  return p.charAt(0).toUpperCase() + p.slice(1)
}

export default function CSVGroupDetailSlideOver({ group, platform, open, onClose, onLinked }: Props) {
  const qc = useQueryClient()
  const [isSearching, setIsSearching] = useState(false)
  const [candidates, setCandidates] = useState<Transaction[]>([])
  const [isNearMatch, setIsNearMatch] = useState(false)
  const [isLinking, setIsLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [isUnlinking, setIsUnlinking] = useState(false)
  const [showCandidates, setShowCandidates] = useState(false)

  const nonTransfer = getNonTransferRows(group)
  const transferRow = getTransferRow(group)
  const expectedDeposit = getExpectedDeposit(group)
  const netTotal = getNetTotal(group)
  const adjustedTotal = getAdjustedTotal(group)
  const closingReserve = getClosingReserve(group)
  const linked = isLinkedGroup(group)
  const linkedId = getLinkedSettlementId(group)

  // Date range of non-transfer rows
  const dates = nonTransfer.map(t => t.date).sort()
  const dateMin = dates[0]
  const dateMax = dates[dates.length - 1]

  async function findMatch() {
    if (!expectedDeposit) return
    setIsSearching(true)
    setCandidates([])
    setLinkError(null)
    setShowCandidates(false)

    // Search window: from group start to 14 days after group end
    const searchEnd = dateMax
      ? new Date(new Date(dateMax).getTime() + 14 * 86400000).toISOString().slice(0, 10)
      : undefined

    // Exact match first
    const { data: exact } = await supabase
      .from('transactions')
      .select('*')
      .eq('source', 'plaid')
      .eq('amount', expectedDeposit)
      .gte('date', dateMin ?? '2000-01-01')
      .lte('date', searchEnd ?? '2099-12-31')
      .order('date')

    if ((exact ?? []).length > 0) {
      setCandidates(exact as Transaction[])
      setIsNearMatch(false)
    } else {
      // Near-match: within ±$5.00
      const lo = expectedDeposit - 5
      const hi = expectedDeposit + 5
      const { data: near } = await supabase
        .from('transactions')
        .select('*')
        .eq('source', 'plaid')
        .gte('amount', lo)
        .lte('amount', hi)
        .gte('date', dateMin ?? '2000-01-01')
        .lte('date', searchEnd ?? '2099-12-31')
        .order('date')
      setCandidates((near ?? []) as Transaction[])
      setIsNearMatch(true)
    }

    setIsSearching(false)
    setShowCandidates(true)
  }

  async function linkTo(candidate: Transaction) {
    setIsLinking(true)
    setLinkError(null)
    try {
      // If near-match, auto-create a gap expense
      if (isNearMatch && expectedDeposit !== undefined) {
        const gap = Math.abs(expectedDeposit - candidate.amount)
        if (gap > 0) {
          await insertTransaction({
            date: candidate.date,
            amount: -gap,
            merchant: `${platformDisplayName(platform)} Disbursement Fee`,
            type: 'fee',
            source: 'manual',
            schedule_c_category: 'commissions_fees',
          })
        }
      }
      await markTransactionAsSettlement(candidate.id, platform)
      await linkCSVGroupToSettlement(group.groupId, candidate.id, platform)
      qc.invalidateQueries({ queryKey: ['csv-groups', platform] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onLinked()
      onClose()
    } catch (e: unknown) {
      setLinkError(e instanceof Error ? e.message : 'Link failed')
    }
    setIsLinking(false)
  }

  async function handleUnlink() {
    setIsUnlinking(true)
    try {
      await unlinkCSVGroup(group.groupId, platform)
      qc.invalidateQueries({ queryKey: ['csv-groups', platform] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onLinked()
      onClose()
    } catch (e: unknown) {
      setLinkError(e instanceof Error ? e.message : 'Unlink failed')
    }
    setIsUnlinking(false)
  }

  return (
    <SlideOver open={open} onClose={onClose} title="Settlement Group">
      <div className="space-y-6 p-4">

        {/* Summary */}
        <section>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Summary</h3>
          <div className="bg-gray-50 rounded-lg p-4 space-y-1 text-sm">
            <SummaryRow label="Net activity" value={netTotal} />
            {group.priorBalance !== 0 && (
              <SummaryRow label="Prior balance" value={group.priorBalance} />
            )}
            <SummaryRow label="Adjusted total" value={adjustedTotal} bold />
            {expectedDeposit !== undefined && (
              <SummaryRow label="Expected deposit" value={expectedDeposit} />
            )}
            {closingReserve !== undefined && closingReserve !== 0 && (
              <SummaryRow label="Closing reserve" value={closingReserve} />
            )}
          </div>
        </section>

        {/* Bank Match */}
        <section>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Bank Match</h3>
          {linked && linkedId ? (
            <LinkedState linkedId={linkedId} onUnlink={handleUnlink} isUnlinking={isUnlinking} />
          ) : expectedDeposit !== undefined ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={findMatch}
                disabled={isSearching}
                className="w-full py-2 px-4 rounded-lg border border-blue-300 text-blue-700 text-sm font-medium hover:bg-blue-50 disabled:opacity-50"
              >
                {isSearching ? 'Searching...' : 'Find Plaid Match'}
              </button>
              {showCandidates && candidates.length === 0 && (
                <p className="text-sm text-gray-500 text-center">No matching bank transactions found.</p>
              )}
              {showCandidates && candidates.length > 0 && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  {isNearMatch && (
                    <div className="bg-amber-50 border-b border-amber-100 px-3 py-2 text-xs text-amber-700">
                      No exact match found. These are close — selecting one will auto-create a gap adjustment expense.
                    </div>
                  )}
                  {candidates.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => linkTo(c)}
                      disabled={isLinking}
                      className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-0 disabled:opacity-50 text-left"
                    >
                      <div>
                        <div className="text-sm font-medium text-gray-900">{c.merchant ?? 'Deposit'}</div>
                        <div className="text-xs text-gray-500">{fmtDate(c.date)} · {c.account_display ?? ''}</div>
                      </div>
                      <span className="text-sm font-semibold text-green-700">{fmtUSD(c.amount)}</span>
                    </button>
                  ))}
                </div>
              )}
              {linkError && <p className="text-sm text-red-600">{linkError}</p>}
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              {platformDisplayName(platform)} held these funds in reserve — no bank deposit was made for this period.
              {closingReserve !== undefined && closingReserve > 0
                ? ` The balance (${fmtUSD(closingReserve)}) carries forward into the next payout. No action needed.`
                : ' No action needed.'}
            </p>
          )}
        </section>

        {/* Transactions */}
        <section>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Transactions ({nonTransfer.length})
          </h3>
          <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
            {[...nonTransfer].sort((a, b) => a.date.localeCompare(b.date)).map(tx => (
              <div key={tx.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <div>
                  <div className="text-gray-900 truncate max-w-[220px]">{tx.merchant ?? tx.type}</div>
                  <div className="text-xs text-gray-500">
                    {fmtDate(tx.date)} · {CATEGORY_LABELS[tx.schedule_c_category ?? ''] ?? tx.schedule_c_category}
                  </div>
                </div>
                <span className={tx.amount >= 0 ? 'text-green-700 font-medium' : 'text-gray-700'}>
                  {fmtUSD(tx.amount)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Payout row */}
        {transferRow && (
          <section>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Payout Row (stored)</h3>
            <div className="flex items-center justify-between px-3 py-2 text-sm border border-gray-200 rounded-lg">
              <div>
                <div className="text-gray-900">{transferRow.merchant ?? 'Payout'}</div>
                <div className="text-xs text-gray-500">{fmtDate(transferRow.date)}</div>
              </div>
              <span className="text-gray-700">{fmtUSD(transferRow.amount)}</span>
            </div>
          </section>
        )}

      </div>
    </SlideOver>
  )
}

function SummaryRow({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  const cls = bold ? 'font-semibold' : ''
  return (
    <div className={`flex justify-between ${cls}`}>
      <span className="text-gray-600">{label}</span>
      <span className={value < 0 ? 'text-red-600' : 'text-gray-900'}>{fmtUSD(value)}</span>
    </div>
  )
}

function LinkedState({ linkedId, onUnlink, isUnlinking }: {
  linkedId: string; onUnlink: () => void; isUnlinking: boolean
}) {
  const [details, setDetails] = useState<Transaction | null>(null)

  // Fetch the linked transaction's details on mount
  useState(() => {
    supabase.from('transactions').select('*').eq('id', linkedId).single()
      .then(({ data }) => { if (data) setDetails(data as Transaction) })
  })

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-sm">
        <span className="text-green-600">✓</span>
        <div className="flex-1">
          {details ? (
            <span className="text-gray-900">
              {details.account_display ?? details.merchant ?? 'Bank deposit'} · {fmtDate(details.date)} · {fmtUSD(details.amount)}
            </span>
          ) : (
            <span className="text-gray-500">Loading...</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onUnlink}
        disabled={isUnlinking}
        className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
      >
        {isUnlinking ? 'Removing...' : 'Remove Match'}
      </button>
    </div>
  )
}
```

**Note:** The `insertTransaction` function signature needs to match what's in `mutations.ts`. Read lines 615–640 of `mutations.ts` and adjust the call to `insertTransaction` to match the actual parameter shape.

- [ ] **Step 2: Build check**

```bash
npm run build 2>&1 | tail -30
```

Fix any type errors. Common issues:
- `SlideOver` props: check `src/components/SlideOver.tsx` for exact prop names (`open`/`isOpen`, `onClose`/`onDismiss`, `title`/`heading`)
- `insertTransaction` params: read the actual function signature in `mutations.ts`
- `account_display` on Transaction: check `src/lib/types.ts` for the exact field name

- [ ] **Step 3: Commit**

```bash
git add src/components/CSVGroupDetailSlideOver.tsx
git commit -m "feat(csv): add CSVGroupDetailSlideOver component"
```

---

## Task 7: SettingsPage — CSV Import Section

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

Read `src/pages/SettingsPage.tsx` fully before editing to see the current return JSX and imports.

- [ ] **Step 1: Add import state and file handler logic**

At the top of `SettingsPage.tsx`, add:

```typescript
import { useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { importMarketplaceCSV, syncCSVOrders } from '../lib/mutations'
import type { CSVImportResult, CSVSaleSyncResult } from '../lib/types'
```

Inside the `SettingsPage` component, add state for all three platforms:

```typescript
type ImportState =
  | { phase: 'idle' }
  | { phase: 'importing' }
  | { phase: 'syncing'; importResult: CSVImportResult }
  | { phase: 'done'; importResult: CSVImportResult; syncResult: CSVSaleSyncResult }
  | { phase: 'error'; message: string }

const qc = useQueryClient()
const [ebayState, setEbayState] = useState<ImportState>({ phase: 'idle' })
const [amazonState, setAmazonState] = useState<ImportState>({ phase: 'idle' })
const [mercariState, setMercariState] = useState<ImportState>({ phase: 'idle' })

const ebayRef = useRef<HTMLInputElement>(null)
const amazonRef = useRef<HTMLInputElement>(null)
const mercariRef = useRef<HTMLInputElement>(null)

async function handleImport(
  platform: string,
  file: File,
  setState: (s: ImportState) => void,
) {
  setState({ phase: 'importing' })
  try {
    const importResult = await importMarketplaceCSV(platform, file)
    setState({ phase: 'syncing', importResult })
    const syncResult = await syncCSVOrders(platform)
    setState({ phase: 'done', importResult, syncResult })
    qc.invalidateQueries({ queryKey: ['csv-groups', platform] })
    qc.invalidateQueries({ queryKey: ['sales'] })
  } catch (e: unknown) {
    setState({ phase: 'error', message: e instanceof Error ? e.message : 'Import failed' })
  }
}
```

- [ ] **Step 2: Add the CSV Import section to the JSX**

Inside the return JSX, after the Custom Categories `</section>` closing tag and before the version footer `<div>`, add:

```tsx
{/* ── CSV Import ─────────────────────────────────────────── */}
<section className="space-y-3">
  <div className="flex items-center justify-between">
    <h2 className="text-lg font-semibold text-gray-900">Marketplace CSV Import</h2>
  </div>
  <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
    <CSVImportCard
      platform="ebay"
      label="eBay"
      description="Seller Hub → Payments → Transaction Report"
      state={ebayState}
      inputRef={ebayRef}
      onPick={() => ebayRef.current?.click()}
      onFile={file => handleImport('ebay', file, setEbayState)}
      onReset={() => setEbayState({ phase: 'idle' })}
    />
    <CSVImportCard
      platform="amazon"
      label="Amazon"
      description="Seller Central → Reports → Payments → Transaction View"
      state={amazonState}
      inputRef={amazonRef}
      onPick={() => amazonRef.current?.click()}
      onFile={file => handleImport('amazon', file, setAmazonState)}
      onReset={() => setAmazonState({ phase: 'idle' })}
    />
    <CSVImportCard
      platform="mercari"
      label="Mercari"
      description="Profile → My Sales → Download"
      state={mercariState}
      inputRef={mercariRef}
      onPick={() => mercariRef.current?.click()}
      onFile={file => handleImport('mercari', file, setMercariState)}
      onReset={() => setMercariState({ phase: 'idle' })}
    />
  </div>
</section>
```

- [ ] **Step 3: Add the CSVImportCard sub-component**

Add this component at the bottom of `SettingsPage.tsx` (before `export default`):

```tsx
type CSVImportCardProps = {
  platform: string
  label: string
  description: string
  state: ImportState
  inputRef: React.RefObject<HTMLInputElement>
  onPick: () => void
  onFile: (file: File) => void
  onReset: () => void
}

function CSVImportCard({ platform, label, description, state, inputRef, onPick, onFile, onReset }: CSVImportCardProps) {
  const busy = state.phase === 'importing' || state.phase === 'syncing'

  return (
    <div className="p-4 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 text-sm">{label}</div>
        <div className="text-xs text-gray-500 mt-0.5">{description}</div>

        {/* Result banner */}
        {(state.phase === 'syncing' || state.phase === 'done') && (
          <div className="mt-2 p-2.5 bg-green-50 border border-green-200 rounded-lg text-xs space-y-1">
            <div className="text-green-800 font-medium">
              {label} import complete — {state.importResult.rows_parsed} rows imported
              {state.importResult.rows_skipped > 0 && `, ${state.importResult.rows_skipped} skipped`}
              {state.importResult.amazon_format && (
                <span className="ml-1 text-green-600">
                  ({state.importResult.amazon_format.replace('_', ' ')})
                </span>
              )}
            </div>
            {state.phase === 'syncing' && (
              <div className="text-green-700 flex items-center gap-1.5">
                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Syncing sales...
              </div>
            )}
            {state.phase === 'done' && (
              <div className="text-green-700">
                {state.syncResult.created > 0 && `${state.syncResult.created} orders added to Sales`}
                {state.syncResult.created > 0 && state.syncResult.updated > 0 && ', '}
                {state.syncResult.updated > 0 && `${state.syncResult.updated} updated`}
                {state.syncResult.created === 0 && state.syncResult.updated === 0 && 'Sales already up to date'}
              </div>
            )}
          </div>
        )}

        {state.phase === 'error' && (
          <div className="mt-2 p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
            {state.message}
            <button type="button" onClick={onReset} className="ml-2 underline">Dismiss</button>
          </div>
        )}
      </div>

      <div className="flex-shrink-0">
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) { onFile(file); e.target.value = '' }
          }}
        />
        <button
          type="button"
          onClick={onPick}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? (state.phase === 'importing' ? 'Importing...' : 'Syncing...') : 'Import CSV'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Build check**

```bash
npm run build 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat(csv): add CSV Import section to SettingsPage"
```

---

## Task 8: SettingsPage — Settlement Status Section

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add imports and state**

Add to `SettingsPage.tsx` imports:

```typescript
import { useCSVGroups, isLinkedGroup, getExpectedDeposit } from '../lib/queries'
import CSVGroupDetailSlideOver from '../components/CSVGroupDetailSlideOver'
import type { CSVGroup } from '../lib/types'
```

Add inside the `SettingsPage` component body:

```typescript
const [settlementPlatform, setSettlementPlatform] = useState<'ebay' | 'amazon'>('ebay')
const { data: csvGroups = [], isLoading: groupsLoading } = useCSVGroups(settlementPlatform)
const [selectedGroup, setSelectedGroup] = useState<CSVGroup | null>(null)
```

- [ ] **Step 2: Add the Settlement Status section to JSX**

After the CSV Import `</section>`, add:

```tsx
{/* ── Settlement Status ──────────────────────────────────── */}
<section className="space-y-3">
  <div className="flex items-center justify-between">
    <h2 className="text-lg font-semibold text-gray-900">Settlement Status</h2>
    {csvGroups.length > 0 && (
      <span className={`text-sm font-medium ${
        csvGroups.filter(isLinkedGroup).length === csvGroups.length
          ? 'text-green-600' : 'text-amber-600'
      }`}>
        {csvGroups.filter(isLinkedGroup).length} of {csvGroups.length} matched
      </span>
    )}
  </div>

  {/* Platform toggle */}
  <div className="flex rounded-lg border border-gray-200 overflow-hidden w-fit">
    {(['ebay', 'amazon'] as const).map(p => (
      <button
        key={p}
        type="button"
        onClick={() => setSettlementPlatform(p)}
        className={`px-4 py-1.5 text-sm font-medium ${
          settlementPlatform === p
            ? 'bg-gray-900 text-white'
            : 'bg-white text-gray-600 hover:bg-gray-50'
        }`}
      >
        {p === 'ebay' ? 'eBay' : 'Amazon'}
      </button>
    ))}
  </div>

  {groupsLoading ? (
    <div className="text-sm text-gray-500 py-4 text-center">Loading...</div>
  ) : csvGroups.length === 0 ? (
    <div className="text-sm text-gray-500 py-4 text-center border border-gray-200 rounded-lg bg-white">
      No {settlementPlatform === 'ebay' ? 'eBay' : 'Amazon'} CSV imports found. Import a Transaction Report above.
    </div>
  ) : (
    <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
      {csvGroups.map(g => {
        const expected = getExpectedDeposit(g)
        const linked = isLinkedGroup(g)
        const dates = g.transactions.map(t => t.date).sort()
        const dateMin = dates[0]
        const dateMax = dates[dates.length - 1]

        return (
          <button
            key={g.groupId}
            type="button"
            onClick={() => setSelectedGroup(g)}
            className="w-full flex items-center gap-3 p-4 hover:bg-gray-50 text-left"
          >
            {/* Status dot */}
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
              linked ? 'bg-green-500' : expected !== undefined ? 'bg-amber-400' : 'bg-gray-300'
            }`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900">
                {settlementPlatform === 'ebay' ? 'eBay' : 'Amazon'} Payout
                {dateMin && dateMax && (
                  <span className="font-normal text-gray-500 ml-1">
                    — {new Date(dateMin + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    –{new Date(dateMax + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {expected !== undefined
                  ? `Expected deposit: $${expected.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                  : 'Held in reserve'}
                {' · '}{g.transactions.length} transactions
              </div>
            </div>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              linked
                ? 'bg-green-100 text-green-700'
                : expected !== undefined
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-gray-100 text-gray-500'
            }`}>
              {linked ? '✓ Matched' : expected !== undefined ? 'Needs Match' : 'On Hold'}
            </span>
          </button>
        )
      })}
    </div>
  )}
</section>

{/* Settlement group detail slide-over */}
{selectedGroup && (
  <CSVGroupDetailSlideOver
    group={selectedGroup}
    platform={settlementPlatform}
    open={selectedGroup !== null}
    onClose={() => setSelectedGroup(null)}
    onLinked={() => {
      qc.invalidateQueries({ queryKey: ['csv-groups', settlementPlatform] })
      setSelectedGroup(null)
    }}
  />
)}
```

- [ ] **Step 3: Build check + tests**

```bash
npm run build 2>&1 | tail -20
npx vitest run 2>&1 | tail -10
```

Expected: build clean, 78/78 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat(csv): add Settlement Status section to SettingsPage"
```

---

## Task 9: Docs + TASKS.md

**Files:**
- Modify: `docs/features/settings.md`
- Modify: `TASKS.md`

Read both files before editing.

- [ ] **Step 1: Update settings.md**

Append a new section to `docs/features/settings.md`:

```markdown
## Marketplace CSV Import

A "Marketplace CSV Import" section (after Custom Categories) has three platform cards — eBay, Amazon, Mercari — each with an "Import CSV" button. Selecting a `.csv` file triggers a two-step flow:

1. **`import_marketplace_csv` edge function (v16)** — parses the CSV and upserts rows into `transactions` with `source='csv_import'`, `platform=<platform>`, and `csv_group_id` linking rows that belong to the same settlement period
2. **`sync_csv_orders_to_sales` edge function (v1)** — groups those transactions by order ref (`notes` field) and upserts `sales` rows with `source='ebay'|'amazon'|'csv_import'`, `external_order_id=<orderRef>`, `item_id=null` (unlinked)

A result banner shows rows imported and sales created/updated.

## Settlement Status

A "Settlement Status" section (after CSV Import) shows eBay and Amazon settlement groups only (Mercari has no disbursement structure). Each group is a `csv_group_id` bucket containing one settlement period's transactions. Groups display:

- **✓ Matched** — linked to a Plaid bank deposit via `parent_settlement_id`
- **Needs Match** — has an expected bank deposit amount (`transfer` row present); tap "Find Plaid Match" in the detail view to search and link
- **On Hold** — eBay/Amazon held funds in reserve; balance carries forward; no action needed

Clicking a group opens `CSVGroupDetailSlideOver` which shows the group summary, bank match UI, transaction list, and payout row.

### Settlement linking flow

1. "Find Plaid Match" searches `transactions` where `source='plaid'` and `amount = expectedDeposit` within the group date range + 14 days. Falls back to ±$5.00 near-match.
2. Selecting a candidate:
   - If near-match: inserts a manual `commissions_fees` transaction for the gap amount
   - Sets `record_type='settlement'`, `schedule_c_category='settlement'`, `platform=<platform>` on the Plaid row (`markTransactionAsSettlement`)
   - Sets `parent_settlement_id=<plaid_tx_id>` on all CSV rows in the group (`linkCSVGroupToSettlement`)
3. "Remove Match" clears `parent_settlement_id` on all CSV rows in the group (`unlinkCSVGroup`)
```

- [ ] **Step 2: Update TASKS.md**

Find and mark these three items as closed in `TASKS.md`:

```
- [ ] **Marketplace CSV import UI**
```
→ Change to `[x]` and append: `_Closed YYYY-MM-DD: file upload cards in SettingsPage; calls import_marketplace_csv (v16) + sync_csv_orders_to_sales (v1)._`

```
- [ ] **Settlement Status view**
```
→ Change to `[x]` and append: `_Closed YYYY-MM-DD: eBay + Amazon settlement groups in SettingsPage; CSVGroupDetailSlideOver handles match/unlink._`

```
- [ ] **CSV → Sales auto-sync**
```
→ Change to `[x]` and append: `_Closed YYYY-MM-DD: sync_csv_orders_to_sales edge function (v1) — groups csv_import transactions by notes field, upserts sales rows; fixes mobile shipping/duplicate/return_status bugs._`

Use today's date: 2026-08-26.

- [ ] **Step 3: Final build + test run**

```bash
npm run build 2>&1 | tail -5
npx vitest run 2>&1 | tail -5
```

Expected: clean build, 78/78 pass.

- [ ] **Step 4: Commit and push**

```bash
git add docs/features/settings.md TASKS.md
git commit -m "docs: document CSV import, settlement status, sync_csv_orders_to_sales"
git push origin main
```

---

## Self-Review Checklist

- [x] **Task 1** covers all three new types + Transaction.csv_group_id + Sale.return_status null
- [x] **Task 2** covers all 8 helper functions + buildCSVGroups + useCSVGroups
- [x] **Task 3** covers all 5 mutations from the spec
- [x] **Task 4** covers the full edge function logic: auth, fetch, group, filter, fetch existing, upsert, orphan delete, return stats
- [x] **Task 5** covers deploy + smoke test
- [x] **Task 6** covers all 4 SlideOver sections: summary, bank match (3 states), transactions, payout row
- [x] **Task 7** covers CSV Import section with all 3 platforms + ImportState machine + result banner
- [x] **Task 8** covers Settlement Status section: platform toggle, group list, status badges, slide-over trigger
- [x] **Task 9** covers docs + TASKS.md closure
- [x] No `TBD` or placeholder steps
- [x] Type names consistent across all tasks: `CSVGroup`, `CSVImportResult`, `CSVSaleSyncResult`, `ImportState`
- [x] Function names consistent: `importMarketplaceCSV`, `syncCSVOrders`, `markTransactionAsSettlement`, `linkCSVGroupToSettlement`, `unlinkCSVGroup`, `buildCSVGroups`, `useCSVGroups`
- [x] Helper names consistent: `getTransferRow`, `getNonTransferRows`, `getExpectedDeposit`, `isLinkedGroup`, `getLinkedSettlementId`, `getNetTotal`, `getAdjustedTotal`, `getClosingReserve`
