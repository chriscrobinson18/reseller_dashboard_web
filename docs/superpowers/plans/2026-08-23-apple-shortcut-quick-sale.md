# Apple Shortcut Quick Sale & Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apple Shortcut that records a quick sale or breakdown from iPhone, with incomplete records surfaced via ⚠️ banners in the web app for later completion.

**Architecture:** Three DB migrations → TypeScript type updates → two edge functions → ⚠️ banners on Sales and Inventory pages → ShortcutsSettingsCard → static shortcut file. Auth via per-user token in `profiles`. No FIFO — all records are unlinked at creation.

**Tech Stack:** Supabase (Postgres, Deno edge functions, service role), React 19 + TanStack React Query, Tailwind v4, Apple Shortcuts app (manual build step).

---

## File Map

| Action | Path |
|---|---|
| Create | `supabase/migrations/20260823100000_add_item_name_to_sales.sql` |
| Create | `supabase/migrations/20260823100001_add_shortcut_token_to_profiles.sql` |
| Create | `supabase/migrations/20260823100002_relax_box_openings_for_shortcut.sql` |
| Modify | `src/lib/types.ts` — `Sale.item_name`, `BoxOpening.box_cost` / `allocation_method` nullable |
| Modify | `src/lib/queries.ts` — add `useIncompleteBreakdowns` |
| Modify | `src/pages/SalesPage.tsx` — ⚠️ banner + item_name display |
| Modify | `src/pages/InventoryPage.tsx` — ⚠️ banner for pending breakdowns |
| Create | `supabase/functions/shortcut_record_sale/index.ts` |
| Create | `supabase/functions/shortcut_record_breakdown/index.ts` |
| Create | `src/components/ShortcutsSettingsCard.tsx` |
| Modify | `src/pages/SettingsPage.tsx` |
| Create | `public/reseller-sale.shortcut` (manual build) |
| Modify | `docs/supabase-schema.md` |
| Modify | `docs/features/sales.md` |

---

## Task 1: Migration — `sales.item_name`

**Files:**
- Create: `supabase/migrations/20260823100000_add_item_name_to_sales.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Free-text item description captured by the Apple Shortcuts quick-sale flow.
-- Preserved after item_id is linked so the original entry is never lost.
alter table public.sales
  add column if not exists item_name text;

comment on column public.sales.item_name is
  'Free-text item name from the Apple Shortcuts quick-sale flow. '
  'Preserved after item_id is set.';
```

- [ ] **Step 2: Apply migration**

Option A — CLI: `supabase db push`
Option B — MCP: call `apply_migration` with the SQL above.

Expected: migration applied with no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260823100000_add_item_name_to_sales.sql
git commit -m "feat(schema): add item_name text column to sales"
```

---

## Task 2: Migration — `profiles.shortcut_token`

**Files:**
- Create: `supabase/migrations/20260823100001_add_shortcut_token_to_profiles.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Create profiles table only if it does not already exist.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade
);

alter table public.profiles enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'profiles'
      and policyname = 'profiles_self_access'
  ) then
    execute $policy$
      create policy "profiles_self_access"
        on public.profiles
        for all
        using  (auth.uid() = id)
        with check (auth.uid() = id)
    $policy$;
  end if;
end
$$;

-- One shortcut token per user; null until the user generates one
alter table public.profiles
  add column if not exists shortcut_token uuid unique;

comment on column public.profiles.shortcut_token is
  'Personal API token for Apple Shortcuts integration. '
  'Regenerating invalidates the previous one. Null = not configured.';
```

- [ ] **Step 2: Apply migration**

Option A — CLI: `supabase db push`
Option B — MCP: call `apply_migration` with the SQL above.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260823100001_add_shortcut_token_to_profiles.sql
git commit -m "feat(schema): add profiles table with shortcut_token"
```

---

## Task 3: Migration — Relax `box_openings` Constraints

**Files:**
- Create: `supabase/migrations/20260823100002_relax_box_openings_for_shortcut.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Allow shortcut-initiated breakdown records where source_lot_id is not yet
-- known. These are detected by source_lot_id IS NULL in the web UI.

-- Drop existing constraints and re-add with null-permissive versions
alter table public.box_openings
  drop constraint if exists box_openings_box_cost_check,
  drop constraint if exists box_openings_allocation_method_check;

alter table public.box_openings
  add constraint box_openings_box_cost_check
    check (box_cost is null or box_cost > 0),
  add constraint box_openings_allocation_method_check
    check (allocation_method is null or allocation_method in ('relative_fmv', 'specific_id', 'equal'));

-- Allow both columns to be null
alter table public.box_openings
  alter column box_cost       drop not null,
  alter column allocation_method drop not null;

comment on column public.box_openings.source_lot_id is
  'The inventory_lots row this box was opened from. '
  'NULL for shortcut-initiated breakdowns awaiting completion in the web app.';
```

- [ ] **Step 2: Apply migration**

Option A — CLI: `supabase db push`
Option B — MCP: call `apply_migration` with the SQL above.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260823100002_relax_box_openings_for_shortcut.sql
git commit -m "feat(schema): allow null box_cost and allocation_method for shortcut breakdowns"
```

---

## Task 4: Update TypeScript Types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Read `src/lib/types.ts`**

Open the file and locate the `Sale` interface and the `BoxOpening` interface.

- [ ] **Step 2: Add `item_name` to `Sale`**

After `item_id?: string`, add:
```typescript
  item_name?: string | null
```

- [ ] **Step 3: Make `BoxOpening.box_cost` and `allocation_method` nullable**

Find:
```typescript
export interface BoxOpening {
  ...
  box_cost: number
  ...
  allocation_method: BoxAllocationMethod
  ...
}
```

Change to:
```typescript
  box_cost: number | null
  ...
  allocation_method: BoxAllocationMethod | null
```

- [ ] **Step 4: Verify build**

```bash
npm run build 2>&1 | head -40
```
Expected: no type errors. If there are errors about `allocation_method` being used where non-null is expected (e.g. in `boxAllocation.ts`), add null guards: `if (!opening.allocation_method) return` at the top of any function that uses it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): item_name on Sale; nullable box_cost + allocation_method on BoxOpening"
```

---

## Task 5: Sales Page — ⚠️ Banner + `item_name` Display

**Files:**
- Modify: `src/pages/SalesPage.tsx`

This task adds two things:
1. A collapsible ⚠️ banner above the sales table when unlinked shortcut sales exist
2. `item_name` shown in the table cell for those sales

- [ ] **Step 1: Read `src/pages/SalesPage.tsx`**

Find: (a) where the main `<table>` or list container starts, (b) the item name cell block around line 462.

- [ ] **Step 2: Add banner state and derived data**

Near the top of the component function (after data fetching), add:

```tsx
const [shortcutBannerOpen, setShortcutBannerOpen] = useState(true)
const shortcutSales = useMemo(
  () => (sales ?? []).filter(s => !s.item_id && s.item_name),
  [sales]
)
```

Make sure `useState` and `useMemo` are imported (they likely already are).

- [ ] **Step 3: Add the ⚠️ banner JSX above the table**

Insert this block immediately before the `<table>` (or the outermost table wrapper div):

```tsx
{shortcutSales.length > 0 && (
  <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50">
    <button
      onClick={() => setShortcutBannerOpen(o => !o)}
      className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-amber-800"
    >
      <span>⚠️ {shortcutSales.length} sale{shortcutSales.length > 1 ? 's' : ''} need attention — item not linked to inventory</span>
      <span className="text-amber-600">{shortcutBannerOpen ? '▲' : '▼'}</span>
    </button>
    {shortcutBannerOpen && (
      <ul className="border-t border-amber-200 divide-y divide-amber-100">
        {shortcutSales.map(sale => (
          <li key={sale.id} className="flex items-center justify-between px-4 py-2 text-sm text-amber-900">
            <button
              className="flex-1 text-left hover:underline"
              onClick={() => setEditSale(sale)}
            >
              {sale.item_name} — {formatUSD(sale.sale_price)} — {sale.sold_at}
            </button>
            <button
              onClick={() => setDeleteSale(sale)}
              className="ml-4 text-xs text-amber-600 hover:text-amber-800"
            >
              dismiss
            </button>
          </li>
        ))}
      </ul>
    )}
  </div>
)}
```

Note: replace `setEditSale` and `setDeleteSale` with whatever the page uses to open the edit modal and delete confirmation respectively — read the existing code to confirm those state setters.

- [ ] **Step 4: Update item name cell to show `item_name`**

Find the item name cell (around line 462):
```tsx
{sale.items?.name ? (
  ...
) : (
  <button onClick={...}>
    <Link2 size={12} /> Link to inventory item
  </button>
)}
```

Replace with:
```tsx
{sale.items?.name ? (
  <>
    <div className="font-medium text-gray-900 truncate max-w-xs">{sale.items.name}</div>
    {sale.items.category && (
      <div className="text-xs text-gray-400">{sale.items.category}</div>
    )}
  </>
) : sale.item_name ? (
  <div>
    <div className="font-medium text-gray-900 truncate max-w-xs">⚠️ {sale.item_name}</div>
    <button
      onClick={e => { e.stopPropagation(); setLinkSale(sale) }}
      className="flex items-center gap-1 text-amber-600 hover:text-amber-800 text-xs font-medium mt-0.5"
    >
      <Link2 size={12} /> Link to inventory
    </button>
  </div>
) : (
  <button
    onClick={e => { e.stopPropagation(); setLinkSale(sale) }}
    className="flex items-center gap-1 text-amber-600 hover:text-amber-800 text-xs font-medium"
  >
    <Link2 size={12} /> Link to inventory item
  </button>
)}
```

- [ ] **Step 5: Update detail panel header to show `item_name`**

Find (around line 221):
```tsx
{sale.items?.name ?? <span className="text-gray-400 italic">Unlinked sale</span>}
```

Replace with:
```tsx
{sale.items?.name ?? sale.item_name ?? <span className="text-gray-400 italic">Unlinked sale</span>}
```

- [ ] **Step 6: Verify build**

```bash
npm run build 2>&1 | head -40
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/SalesPage.tsx
git commit -m "feat(sales): warning banner and item_name display for shortcut-initiated sales"
```

---

## Task 6: Inventory Page — ⚠️ Banner for Pending Breakdowns

**Files:**
- Modify: `src/lib/queries.ts` — add `useIncompleteBreakdowns`
- Modify: `src/pages/InventoryPage.tsx` — add banner

### Part A: Query

- [ ] **Step 1: Read `src/lib/queries.ts`**

Find an existing `useQuery` hook to use as a pattern (e.g., `useItems`).

- [ ] **Step 2: Add `useIncompleteBreakdowns` hook**

Add after the last existing hook in `queries.ts`:

```typescript
export function useIncompleteBreakdowns() {
  return useQuery({
    queryKey: ['incomplete_breakdowns'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('box_openings')
        .select('id, box_name, quantity, opened_at')
        .is('source_lot_id', null)
        .is('deleted_at', null)
        .order('opened_at', { ascending: false })
      if (error) throw error
      return data as Array<{
        id: string
        box_name: string
        quantity: number
        opened_at: string
      }>
    },
  })
}
```

### Part B: Banner in InventoryPage

- [ ] **Step 3: Read `src/pages/InventoryPage.tsx`**

Find: (a) the imports block, (b) the action buttons row (`Record Trade | Breakdown Inventory | Add Item`), (c) where the main table/content starts.

- [ ] **Step 4: Add import and hook call**

Add import at top:
```typescript
import { useItems, useIncompleteBreakdowns } from '../lib/queries'
```
(Replace the existing `useItems` import line — just add `useIncompleteBreakdowns` to the same import.)

Inside the component, after existing hook calls, add:
```tsx
const { data: incompleteBreakdowns = [] } = useIncompleteBreakdowns()
const [breakdownBannerOpen, setBreakdownBannerOpen] = useState(true)
```

- [ ] **Step 5: Add delete mutation for incomplete breakdowns**

After existing mutations, add:
```tsx
const deleteIncompleteBreakdown = useMutation({
  mutationFn: async (id: string) => {
    const { error } = await supabase
      .from('box_openings')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
  },
  onSuccess: () => qc.invalidateQueries({ queryKey: ['incomplete_breakdowns'] }),
})
```

Make sure `supabase` is imported in InventoryPage — check existing imports. If not, add:
```typescript
import { supabase } from '../lib/supabase'
```

- [ ] **Step 6: Add the ⚠️ banner JSX**

Insert immediately after the action buttons row and before the main table/content div:

```tsx
{incompleteBreakdowns.length > 0 && (
  <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50">
    <button
      onClick={() => setBreakdownBannerOpen(o => !o)}
      className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-amber-800"
    >
      <span>
        ⚠️ {incompleteBreakdowns.length} breakdown{incompleteBreakdowns.length > 1 ? 's' : ''} need completion — source item not linked
      </span>
      <span className="text-amber-600">{breakdownBannerOpen ? '▲' : '▼'}</span>
    </button>
    {breakdownBannerOpen && (
      <ul className="border-t border-amber-200 divide-y divide-amber-100">
        {incompleteBreakdowns.map(b => (
          <li key={b.id} className="flex items-center justify-between px-4 py-2 text-sm text-amber-900">
            <span className="flex-1">
              {b.box_name} — {b.quantity} unit{b.quantity > 1 ? 's' : ''} — {b.opened_at}
            </span>
            <span className="ml-4 text-xs text-amber-600 italic mr-3">
              Use "Breakdown Inventory" to complete
            </span>
            <button
              onClick={() => deleteIncompleteBreakdown.mutate(b.id)}
              className="text-xs text-red-500 hover:text-red-700"
            >
              delete
            </button>
          </li>
        ))}
      </ul>
    )}
  </div>
)}
```

- [ ] **Step 7: Verify build**

```bash
npm run build 2>&1 | head -40
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/queries.ts src/pages/InventoryPage.tsx
git commit -m "feat(inventory): warning banner for shortcut-initiated incomplete breakdowns"
```

---

## Task 7: Edge Function — `shortcut_record_sale`

**Files:**
- Create: `supabase/functions/shortcut_record_sale/index.ts`

- [ ] **Step 1: Create the edge function**

```typescript
// shortcut_record_sale — quick sale entry from Apple Shortcuts.
// Auth: token lookup via service role (no JWT required from caller).
// No FIFO depletion — sale is created unlinked (item_id = null).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { shortcut_token, item_name, quantity, sale_price, payment_method } = body;

    if (!shortcut_token) return json(401, { error: "Missing shortcut_token" });
    if (!item_name?.trim()) return json(400, { error: "Missing field: item_name" });
    if (!quantity || Number(quantity) <= 0) return json(400, { error: "Missing field: quantity (must be > 0)" });
    if (sale_price == null || isNaN(Number(sale_price))) return json(400, { error: "Missing field: sale_price" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("shortcut_token", shortcut_token)
      .maybeSingle();

    if (!profile) return json(401, { error: "Invalid shortcut token" });

    const soldAt = new Date().toISOString().split("T")[0];
    const netPayout = Number(sale_price);

    const { data: sale, error: saleError } = await supabase
      .from("sales")
      .insert({
        user_id: profile.id,
        item_id: null,
        item_name: item_name.trim(),
        quantity: Number(quantity),
        sale_price: netPayout,
        payment_method: payment_method ?? null,
        source: "manual",
        platform: "manual",
        sold_at: soldAt,
        fees: 0,
        shipping_cost: 0,
        net_payout: netPayout,
        inventory_status: "ok",
        return_status: "none",
        refunded_quantity: 0,
      })
      .select("id")
      .single();

    if (saleError) throw saleError;
    return json(200, { success: true, sale_id: sale.id });
  } catch (err) {
    return json(500, { error: String(err) });
  }
});
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy shortcut_record_sale
```
Expected: `Deployed Functions shortcut_record_sale`

- [ ] **Step 3: Smoke test**

```bash
curl -X POST https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_sale \
  -H "Content-Type: application/json" \
  -d '{"shortcut_token":"<your-token>","item_name":"Test Item","quantity":1,"sale_price":50,"payment_method":"cash"}'
```
Expected: `{"success":true,"sale_id":"<uuid>"}`

Test invalid token → expect HTTP 401.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/shortcut_record_sale/
git commit -m "feat(edge): shortcut_record_sale — token-auth quick sale"
```

---

## Task 8: Edge Function — `shortcut_record_breakdown`

**Files:**
- Create: `supabase/functions/shortcut_record_breakdown/index.ts`

- [ ] **Step 1: Create the edge function**

```typescript
// shortcut_record_breakdown — quick breakdown entry from Apple Shortcuts.
// Auth: token lookup via service role (no JWT required from caller).
// Creates an incomplete box_openings row (source_lot_id = null, box_cost = null).
// The user completes it in the web app via "Breakdown Inventory".
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { shortcut_token, item_name, quantity } = body;

    if (!shortcut_token) return json(401, { error: "Missing shortcut_token" });
    if (!item_name?.trim()) return json(400, { error: "Missing field: item_name" });
    if (!quantity || Number(quantity) <= 0) return json(400, { error: "Missing field: quantity (must be > 0)" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("shortcut_token", shortcut_token)
      .maybeSingle();

    if (!profile) return json(401, { error: "Invalid shortcut token" });

    const openedAt = new Date().toISOString().split("T")[0];

    const { data: opening, error: openingError } = await supabase
      .from("box_openings")
      .insert({
        user_id: profile.id,
        box_name: item_name.trim(),
        quantity: Number(quantity),
        opened_at: openedAt,
        source_lot_id: null,
        box_cost: null,
        allocation_method: null,
        transaction_id: null,
      })
      .select("id")
      .single();

    if (openingError) throw openingError;
    return json(200, { success: true, box_opening_id: opening.id });
  } catch (err) {
    return json(500, { error: String(err) });
  }
});
```

- [ ] **Step 2: Deploy**

```bash
supabase functions deploy shortcut_record_breakdown
```
Expected: `Deployed Functions shortcut_record_breakdown`

- [ ] **Step 3: Smoke test**

```bash
curl -X POST https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_breakdown \
  -H "Content-Type: application/json" \
  -d '{"shortcut_token":"<your-token>","item_name":"Topps Blaster Box","quantity":1}'
```
Expected: `{"success":true,"box_opening_id":"<uuid>"}`

Open the Inventory page in the web app — confirm the ⚠️ banner appears with "Topps Blaster Box".

Test invalid token → expect HTTP 401.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/shortcut_record_breakdown/
git commit -m "feat(edge): shortcut_record_breakdown — token-auth quick breakdown entry"
```

---

## Task 9: `ShortcutsSettingsCard` Component

**Files:**
- Create: `src/components/ShortcutsSettingsCard.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import ConfirmDialog from './ConfirmDialog'

async function fetchShortcutToken(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('profiles')
    .select('shortcut_token')
    .eq('id', user.id)
    .maybeSingle()
  return data?.shortcut_token ?? null
}

async function upsertShortcutToken(token: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, shortcut_token: token }, { onConflict: 'id' })
  if (error) throw error
}

export default function ShortcutsSettingsCard() {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const { data: token } = useQuery({
    queryKey: ['shortcut_token'],
    queryFn: fetchShortcutToken,
  })

  const generateMutation = useMutation({
    mutationFn: async () => {
      const newToken = crypto.randomUUID()
      await upsertShortcutToken(newToken)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shortcut_token'] })
      setShowConfirm(false)
    },
  })

  function handleCopy() {
    if (!token) return
    navigator.clipboard.writeText(token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <section className="space-y-3">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Apple Shortcuts</h2>
        </header>
        <div className="border border-gray-200 rounded-lg bg-white p-4 space-y-4">
          <p className="text-sm text-gray-500">
            Record sales and breakdowns quickly from your iPhone. Generate a
            token, copy it, then tap <strong>Add to Shortcuts</strong> and paste
            when prompted on first run.
          </p>

          {!token ? (
            <button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 transition-colors"
            >
              {generateMutation.isPending ? 'Generating…' : 'Generate Token'}
            </button>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded text-xs font-mono text-gray-700 truncate">
                  {token}
                </code>
                <button
                  onClick={handleCopy}
                  className="shrink-0 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="flex gap-2">
                <a
                  href="/reseller-sale.shortcut"
                  download
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                >
                  Add to Shortcuts
                </a>
                <button
                  onClick={() => setShowConfirm(true)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Regenerate
                </button>
              </div>
            </div>
          )}

          {generateMutation.error && (
            <p className="text-sm text-red-600">{String(generateMutation.error)}</p>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={showConfirm}
        title="Regenerate Shortcut Token?"
        message="This will invalidate your current Shortcut. The next time you run it, you'll be prompted to paste your new token."
        confirmLabel="Regenerate"
        loading={generateMutation.isPending}
        onConfirm={() => generateMutation.mutate()}
        onCancel={() => setShowConfirm(false)}
      />
    </>
  )
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ShortcutsSettingsCard.tsx
git commit -m "feat(settings): ShortcutsSettingsCard — token generate/copy/regenerate"
```

---

## Task 10: Wire into `SettingsPage`

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add import**

At the top of `src/pages/SettingsPage.tsx`, add:
```tsx
import ShortcutsSettingsCard from '../components/ShortcutsSettingsCard'
```

- [ ] **Step 2: Add to JSX**

After the Custom Categories `<section>` block and before the Plaid env debug line, insert:
```tsx
<ShortcutsSettingsCard />
```

- [ ] **Step 3: Manual smoke test**

```bash
npm run dev
```
Navigate to `/settings`. Confirm:
- "Apple Shortcuts" section is visible
- "Generate Token" button works, displays UUID
- Copy button puts UUID on clipboard
- Regenerate shows ConfirmDialog
- "Add to Shortcuts" link points to `/reseller-sale.shortcut`

- [ ] **Step 4: Verify build**

```bash
npm run build 2>&1 | head -30
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat(settings): add Apple Shortcuts card to Settings page"
```

---

## Task 11: Build Apple Shortcut File

**Files:**
- Create: `public/reseller-sale.shortcut` (binary — built manually in Shortcuts app)

This is a manual step. The `.shortcut` format is a binary Apple plist that cannot be generated programmatically.

- [ ] **Step 1: Open Shortcuts app on iPhone or Mac, create a new shortcut named "Log Sale"**

- [ ] **Step 2: Build the token-check block**

1. **Get Variable** → `ResellerConfig` (Dictionary type)
2. **If** Dictionary value for key `"token"` is empty:
   - **Ask for Input** (Text): `"Paste your Shortcut Token (find it in Settings > Apple Shortcuts)"`
   - **Set Dictionary Value** for key `"token"` = input
   - **Set Variable** `ResellerConfig` = updated dictionary
3. **Get Dictionary Value** for key `"token"` from `ResellerConfig` → set variable `ShortcutToken`

- [ ] **Step 3: Build the mode choice**

4. **Choose from List**: `Record a Sale`, `Break Down Inventory` → set variable `Mode`

- [ ] **Step 4: Build the Sale branch (inside an If `Mode` is `Record a Sale`)**

5. **Ask for Input** (Text): `"What did you sell?"` → variable `ItemName`
6. **Ask for Input** (Number, default 1): `"Quantity?"` → variable `Qty`
7. **Ask for Input** (Number): `"Sale price?"` → variable `SalePrice`
8. **Choose from List**: Cash / Venmo / Cash App / PayPal / Apple Pay / Zelle / Card / Other → variable `PayLabel`
9. **If/Otherwise If** chain to map `PayLabel` → `PayValue`:
   - Cash → `cash`, Venmo → `venmo`, Cash App → `cashapp`, PayPal → `paypal`,
     Apple Pay → `apple_pay`, Zelle → `zelle`, Card → `card`, Other → `other`
10. **Get Contents of URL**:
    - URL: `https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_sale`
    - Method: POST · Headers: `Content-Type: application/json`
    - JSON body: `{ shortcut_token: ShortcutToken, item_name: ItemName, quantity: Qty, sale_price: SalePrice, payment_method: PayValue }`
11. **If** result contains key `"success"`:
    - **Show Notification**: `"Sale recorded — ItemName $SalePrice"`
    **Otherwise**: **Show Alert**: `"Error recording sale. Check your token in Settings."`

- [ ] **Step 5: Build the Breakdown branch (inside Otherwise / else)**

12. **Ask for Input** (Text): `"What are you breaking down?"` → variable `ItemName`
13. **Ask for Input** (Number, default 1): `"Quantity?"` → variable `Qty`
14. **Get Contents of URL**:
    - URL: `https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_breakdown`
    - Method: POST · Headers: `Content-Type: application/json`
    - JSON body: `{ shortcut_token: ShortcutToken, item_name: ItemName, quantity: Qty }`
15. **If** result contains key `"success"`:
    - **Show Notification**: `"Breakdown recorded — ItemName ×Qty"`
    **Otherwise**: **Show Alert**: `"Error recording breakdown. Check your token in Settings."`

- [ ] **Step 6: Test end-to-end**

Generate a token in Settings, run the shortcut, paste token when prompted.
- Record a Sale → verify it appears in the Sales page with ⚠️ badge and in the banner
- Record a Breakdown → verify it appears in the Inventory page ⚠️ banner

- [ ] **Step 7: Export and commit**

On iPhone: shortcut `...` menu → Share → Save to Files → `reseller-sale.shortcut`
On Mac: right-click shortcut → Share → save to `public/` in the repo.

```bash
ls public/reseller-sale.shortcut  # confirm file is there
git add public/reseller-sale.shortcut
git commit -m "feat(shortcut): Apple Shortcut file for quick sale and breakdown entry"
```

---

## Task 12: Update Docs

**Files:**
- Modify: `docs/supabase-schema.md`
- Modify: `docs/features/sales.md`

- [ ] **Step 1: Update `docs/supabase-schema.md`**

In the `sales` table columns section, add after `item_id`:
```
| `item_name` | text | Nullable. Free-text item description from Shortcuts quick-sale. Preserved after `item_id` is linked. |
```

In the `box_openings` table section, update `box_cost` and `allocation_method` entries to note they are now nullable for shortcut-initiated records.

Add a `profiles` table section (or update if present):
```markdown
### `profiles`
Per-user settings. `id` is FK → `auth.users`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, FK → `auth.users(id)` ON DELETE CASCADE |
| `shortcut_token` | uuid | Unique. Personal API token for Apple Shortcuts. Null = not configured. |
```

- [ ] **Step 2: Update `docs/features/sales.md`**

Add a section:
```markdown
## Apple Shortcuts quick entry

Users record unlinked manual sales from iPhone without opening the web app.

**Setup:** Settings → Apple Shortcuts → Generate Token → Copy → Add to Shortcuts → paste token on first run.

**Fields captured (sale):** item name, quantity, sale price, payment method. Date defaults to today UTC.
**Fields captured (breakdown):** item name, quantity. Date defaults to today UTC.

**Auth:** `profiles.shortcut_token` UUID. The edge functions use service role — no JWT required in the Shortcut.

**Attention banners:** The Sales page shows a ⚠️ banner for unlinked shortcut sales (`item_id IS NULL AND item_name IS NOT NULL`). The Inventory page shows a ⚠️ banner for incomplete breakdowns (`box_openings.source_lot_id IS NULL`).

**Regenerating** the token in Settings immediately invalidates the old one.
```

- [ ] **Step 3: Commit**

```bash
git add docs/supabase-schema.md docs/features/sales.md
git commit -m "docs: Apple Shortcuts integration — schema, sales feature, banners"
```

---

## Self-Review

**Spec coverage:**
- [x] `profiles.shortcut_token` — Task 2
- [x] `sales.item_name` — Task 1
- [x] `box_openings` constraints relaxed — Task 3
- [x] `BoxOpening` type nullable — Task 4
- [x] Sales ⚠️ banner — Task 5
- [x] Sales table shows `item_name` with ⚠️ prefix — Task 5
- [x] Inventory ⚠️ banner for pending breakdowns — Task 6
- [x] `useIncompleteBreakdowns` query — Task 6
- [x] Edge function `shortcut_record_sale` — Task 7
- [x] Edge function `shortcut_record_breakdown` — Task 8
- [x] Settings card: generate/copy/regenerate — Task 9 + 10
- [x] "Add to Shortcuts" download link — Task 9
- [x] Shortcut: Sale or Breakdown choice — Task 11
- [x] Shortcut: sale prompts (name, qty, price, payment) — Task 11
- [x] Shortcut: breakdown prompts (name, qty) — Task 11
- [x] Token persisted in ResellerConfig dictionary — Task 11
- [x] Docs updated — Task 12

**Type consistency:** `BoxOpening.box_cost: number | null` and `allocation_method: BoxAllocationMethod | null` defined in Task 4, inserted as null in Task 8 edge function. `Sale.item_name?: string | null` defined in Task 4, inserted in Task 7, displayed in Task 5. All consistent.

**No placeholders:** All code is complete. Task 5 Step 3 and Task 6 Step 6 note to verify state setter names (`setEditSale`, `setDeleteSale`) by reading the file first — this is a read-before-edit instruction, not a placeholder.
