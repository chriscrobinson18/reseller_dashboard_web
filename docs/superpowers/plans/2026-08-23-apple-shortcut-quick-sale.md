# Apple Shortcut Quick Sale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to record an unlinked manual sale from an Apple Shortcut on their iPhone, with auth via a one-time token generated in the web app's Settings page.

**Architecture:** Two DB migrations (new `sales.item_name` column + `profiles` table with `shortcut_token`), a new edge function that validates the token and inserts the sale, a `ShortcutsSettingsCard` React component for token management, and a static `.shortcut` file served from `public/`. No FIFO inventory depletion — the sale appears as an unlinked manual entry linkable later.

**Tech Stack:** Supabase (Postgres migrations, Deno edge function, service role client), React 19 + TanStack React Query, Tailwind v4, Apple Shortcuts app (manual build).

---

## File Map

| Action | Path |
|---|---|
| Create | `supabase/migrations/20260823100000_add_item_name_to_sales.sql` |
| Create | `supabase/migrations/20260823100001_add_shortcut_token_to_profiles.sql` |
| Modify | `src/lib/types.ts` — add `item_name` to `Sale` |
| Modify | `src/pages/SalesPage.tsx` — show `item_name` when sale is unlinked |
| Create | `supabase/functions/shortcut_record_sale/index.ts` |
| Create | `src/components/ShortcutsSettingsCard.tsx` |
| Modify | `src/pages/SettingsPage.tsx` — add shortcuts section |
| Create | `public/reseller-sale.shortcut` — built manually in Shortcuts app |
| Modify | `docs/supabase-schema.md` |
| Modify | `docs/features/sales.md` |

---

## Task 1: Migration — `sales.item_name`

**Files:**
- Create: `supabase/migrations/20260823100000_add_item_name_to_sales.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Stores the free-text item description captured by the Apple Shortcuts
-- quick-sale integration. Preserved after the sale is linked to an
-- inventory_items row via item_id.
alter table public.sales
  add column if not exists item_name text;

comment on column public.sales.item_name is
  'Free-text item name captured by the Apple Shortcuts quick-sale flow. '
  'Preserved after item_id is set so the original entry is never lost.';
```

- [ ] **Step 2: Apply migration**

Option A (Supabase CLI):
```bash
supabase db push
```
Expected: `Applied 1 migration`

Option B (MCP tool): Call `apply_migration` with the SQL above.

- [ ] **Step 3: Verify column exists**

```bash
supabase db diff
```
Expected: empty diff (migration applied cleanly).

- [ ] **Step 4: Commit**

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
-- Supabase projects sometimes auto-create this; this migration is safe either way.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade
);

alter table public.profiles enable row level security;

-- Only create the policy if it doesn't already exist
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
  'Personal API token for the Apple Shortcuts quick-sale integration. '
  'Regenerating it invalidates the previous one. Null = no shortcut configured.';
```

- [ ] **Step 2: Apply migration**

Option A (Supabase CLI):
```bash
supabase db push
```
Expected: `Applied 1 migration`

Option B (MCP tool): Call `apply_migration` with the SQL above.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260823100001_add_shortcut_token_to_profiles.sql
git commit -m "feat(schema): add profiles table with shortcut_token for Apple Shortcuts auth"
```

---

## Task 3: Update `Sale` TypeScript Type

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Read the file**

Open `src/lib/types.ts`. Find the `Sale` interface. It starts with:
```typescript
export interface Sale {
  id: string
  user_id: string
  item_id?: string
  platform?: string
  source: 'manual' | 'csv_import' | 'plaid' | 'trade'
  ...
```

- [ ] **Step 2: Add `item_name` field after `item_id`**

Add this line after `item_id?: string`:
```typescript
  item_name?: string | null
```

The block should now read:
```typescript
export interface Sale {
  id: string
  user_id: string
  item_id?: string
  item_name?: string | null
  platform?: string
  source: 'manual' | 'csv_import' | 'plaid' | 'trade'
  ...
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -30
```
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add item_name to Sale interface"
```

---

## Task 4: Show `item_name` in Sales List for Unlinked Shortcut Sales

**Files:**
- Modify: `src/pages/SalesPage.tsx`

Currently, when `sale.items` is null the table cell shows "Link to inventory item" and the detail panel shows "Unlinked sale". We add `item_name` as an intermediate display state.

- [ ] **Step 1: Update the table cell (item name column)**

Find this block (around line 462):
```tsx
{sale.items?.name ? (
  <>
    <div className="font-medium text-gray-900 truncate max-w-xs">{sale.items.name}</div>
    {sale.items.category && (
      <div className="text-xs text-gray-400">{sale.items.category}</div>
    )}
  </>
) : (
  <button
    onClick={e => { e.stopPropagation(); setLinkSale(sale) }}
    className="flex items-center gap-1 text-amber-600 hover:text-amber-800 text-xs font-medium"
  >
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
    <div className="font-medium text-gray-900 truncate max-w-xs">{sale.item_name}</div>
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

- [ ] **Step 2: Update the detail panel header**

Find this block (around line 221):
```tsx
<div className="text-sm font-medium text-gray-700 mt-1">
  {sale.items?.name ?? <span className="text-gray-400 italic">Unlinked sale</span>}
</div>
```

Replace with:
```tsx
<div className="text-sm font-medium text-gray-700 mt-1">
  {sale.items?.name ?? sale.item_name ?? <span className="text-gray-400 italic">Unlinked sale</span>}
</div>
```

- [ ] **Step 3: Verify build**

```bash
npm run build 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/SalesPage.tsx
git commit -m "feat(sales): show item_name for unlinked shortcut sales in list + detail panel"
```

---

## Task 5: Edge Function `shortcut_record_sale`

**Files:**
- Create: `supabase/functions/shortcut_record_sale/index.ts`

- [ ] **Step 1: Create the edge function**

```typescript
// shortcut_record_sale — inserts an unlinked manual sale for the user
// identified by shortcut_token in profiles. No FIFO inventory depletion.
// Auth: token lookup via service role (no JWT required from caller).
//
// Request body:
//   shortcut_token  uuid    – personal token from Settings > Apple Shortcuts
//   item_name       string  – free-text item description
//   quantity        number  – units sold (must be > 0)
//   sale_price      number  – gross sale amount
//   payment_method  string? – e.g. "cash", "venmo", "paypal" (optional)

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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Service role — bypasses RLS so we can look up any profile by token
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { shortcut_token, item_name, quantity, sale_price, payment_method } =
      body;

    // Validate required fields
    if (!shortcut_token)
      return json(401, { error: "Missing shortcut_token" });
    if (!item_name || typeof item_name !== "string" || !item_name.trim())
      return json(400, { error: "Missing field: item_name" });
    if (!quantity || Number(quantity) <= 0)
      return json(400, { error: "Missing field: quantity (must be > 0)" });
    if (sale_price == null || isNaN(Number(sale_price)))
      return json(400, { error: "Missing field: sale_price" });

    // Resolve user from token
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("shortcut_token", shortcut_token)
      .maybeSingle();

    if (!profile) {
      return json(401, { error: "Invalid shortcut token" });
    }

    const soldAt = new Date().toISOString().split("T")[0]; // YYYY-MM-DD UTC
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

- [ ] **Step 2: Deploy the edge function**

```bash
supabase functions deploy shortcut_record_sale
```
Expected: `Deployed Functions shortcut_record_sale`

- [ ] **Step 3: Smoke test with curl**

First generate a token via the Settings UI (Task 6) or directly via Supabase Studio. Then:

```bash
curl -X POST https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_sale \
  -H "Content-Type: application/json" \
  -d '{
    "shortcut_token": "<your-generated-uuid>",
    "item_name": "Test Sneaker",
    "quantity": 1,
    "sale_price": 150.00,
    "payment_method": "cash"
  }'
```
Expected: `{"success":true,"sale_id":"<uuid>"}`

Verify the sale appears in the web app's Sales page with item name "Test Sneaker", source "manual", unlinked (no inventory item).

- [ ] **Step 4: Test invalid token**

```bash
curl -X POST https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_sale \
  -H "Content-Type: application/json" \
  -d '{"shortcut_token":"00000000-0000-0000-0000-000000000000","item_name":"x","quantity":1,"sale_price":1}'
```
Expected: `{"error":"Invalid shortcut token"}` with HTTP 401.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/shortcut_record_sale/
git commit -m "feat(edge): shortcut_record_sale — token-auth quick sale entry"
```

---

## Task 6: `ShortcutsSettingsCard` Component

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
            Record sales quickly from your iPhone. Generate a token, copy it, then
            tap <strong>Add to Shortcuts</strong> and paste when prompted.
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

## Task 7: Wire `ShortcutsSettingsCard` into `SettingsPage`

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add import**

At the top of `src/pages/SettingsPage.tsx`, after the existing imports, add:
```tsx
import ShortcutsSettingsCard from '../components/ShortcutsSettingsCard'
```

- [ ] **Step 2: Add section to the page**

In the return JSX, after the `<section>` block for Custom Categories (and before the closing `</div>` of the outer container), add:
```tsx
<ShortcutsSettingsCard />
```

The outer `div` should now end like:
```tsx
      <section className="space-y-3">
        ...CustomCategoriesList...
      </section>

      <ShortcutsSettingsCard />

      {plaidEnv && plaidEnv !== 'production' && (
        <div className="text-xs text-gray-400 text-center pt-6">
          Plaid env: {plaidEnv}
        </div>
      )}
    </div>
  )
```

- [ ] **Step 3: Manual smoke test**

```bash
npm run dev
```
Open `http://localhost:5173/settings`. Confirm:
- "Apple Shortcuts" section is visible
- "Generate Token" button appears
- Clicking it shows a UUID in a code block with Copy + Add to Shortcuts + Regenerate buttons
- Copying puts the UUID on clipboard
- Regenerate shows the ConfirmDialog with the correct message

- [ ] **Step 4: Verify build**

```bash
npm run build 2>&1 | head -30
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat(settings): add Apple Shortcuts section to Settings page"
```

---

## Task 8: Build and Commit the Apple Shortcut File

**Files:**
- Create: `public/reseller-sale.shortcut` (binary plist — built in Shortcuts app)

The `.shortcut` format is a binary Apple plist. Build it manually in the iPhone/Mac Shortcuts app following these exact steps:

- [ ] **Step 1: Open Shortcuts app on iPhone or Mac, create a new shortcut named "Log Sale"**

- [ ] **Step 2: Add these actions in order**

1. **Get Variable** → name: `ResellerConfig` (type: Dictionary)
   - If the variable is empty (no key "token"), continue to step 2a; otherwise skip to step 3

2a. **Ask for Input** → prompt: `"Paste your Shortcut Token (find it in Settings > Apple Shortcuts)"`, type: Text
2b. **Set Variable** → name: `ShortcutToken`, to: result of 2a
2c. **Set Dictionary** key `"token"` = `ShortcutToken`, store back in `ResellarConfig`

_(Shortcut will store this automatically for next run)_

3. **Get Dictionary Value** key `"token"` from `ResellerConfig` → set variable `ShortcutToken`

4. **Ask for Input** → prompt: `"What did you sell?"`, type: Text → set variable `ItemName`

5. **Ask for Input** → prompt: `"Quantity?"`, type: Number, default: `1` → set variable `Qty`

6. **Ask for Input** → prompt: `"Sale price?"`, type: Number → set variable `SalePrice`

7. **Choose from List** → items: `Cash`, `Venmo`, `Cash App`, `PayPal`, `Apple Pay`, `Zelle`, `Card`, `Other` → set variable `PaymentLabel`

8. **If** `PaymentLabel` is `Cash` → set variable `PaymentValue` = `cash`
   **Otherwise If** `Cash App` → `cashapp`
   **Otherwise If** `Venmo` → `venmo`
   **Otherwise If** `PayPal` → `paypal`
   **Otherwise If** `Apple Pay` → `apple_pay`
   **Otherwise If** `Zelle` → `zelle`
   **Otherwise If** `Card` → `card`
   **Otherwise** → `other`

9. **Get Contents of URL**
   - URL: `https://qmizmnbzergqbpgyqseg.supabase.co/functions/v1/shortcut_record_sale`
   - Method: `POST`
   - Headers: `Content-Type: application/json`
   - Request Body: **JSON** with keys:
     - `shortcut_token` → `ShortcutToken`
     - `item_name` → `ItemName`
     - `quantity` → `Qty`
     - `sale_price` → `SalePrice`
     - `payment_method` → `PaymentValue`

10. **Get Dictionary Value** key `"sale_id"` from result of step 9 → if not empty:
    **Show Notification**: `"Sale recorded — ItemName $SalePrice"`
    **Otherwise**:
    **Show Alert**: `"Error recording sale. Check your token in Settings."`

- [ ] **Step 3: Run the shortcut once to verify it works end-to-end**

Generate a token in Settings, run the shortcut, paste the token when prompted, fill in a test sale. Verify the sale appears in the Sales page with the correct name, price, and payment method.

- [ ] **Step 4: Export and commit the shortcut file**

On iPhone: tap the shortcut's `...` menu → Share → Save to Files → save as `reseller-sale.shortcut`
On Mac: right-click shortcut → Share → save to the repo's `public/` folder.

```bash
# Confirm the file landed in public/
ls public/reseller-sale.shortcut
```

```bash
git add public/reseller-sale.shortcut
git commit -m "feat(shortcut): add Apple Shortcut file for quick sale entry"
```

---

## Task 9: Update Docs

**Files:**
- Modify: `docs/supabase-schema.md`
- Modify: `docs/features/sales.md`

- [ ] **Step 1: Update `docs/supabase-schema.md`**

In the `sales` table column list, add after `item_id`:
```
| `item_name` | text | Nullable. Free-text item description from Apple Shortcuts quick-sale flow. Preserved after `item_id` is linked. |
```

Add a new `profiles` table section (or add to existing if present):
```markdown
### `profiles`
Stores per-user app settings. Created by migration; `id` is a FK to `auth.users`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, FK → `auth.users(id)` ON DELETE CASCADE |
| `shortcut_token` | uuid | Unique. Personal API token for Apple Shortcuts integration. Null = not configured. |
```

- [ ] **Step 2: Update `docs/features/sales.md`**

Add a section (or paragraph) on the Apple Shortcuts integration:

```markdown
## Apple Shortcuts quick entry

Users can record unlinked manual sales from the iPhone Shortcuts app without opening the web app.

**Setup:** Settings → Apple Shortcuts → Generate Token → Copy → Add to Shortcuts → paste token on first run.

**Fields captured:** item name (free text), quantity, sale price, payment method. Sale date defaults to today UTC. No FIFO depletion — the sale is created with `item_id = null` and `source = 'manual'`. The `item_name` column stores the original description even after the sale is linked to an inventory item.

**Auth:** A `shortcut_token uuid` column on `profiles` identifies the user. The `shortcut_record_sale` edge function uses the service role to look up the user — no JWT required in the Shortcut.

**Regenerating the token** in Settings immediately invalidates the old one. The Shortcut will prompt for a new token on the next run (it stores the token in a local Shortcuts Dictionary variable named `ResellerConfig`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/supabase-schema.md docs/features/sales.md
git commit -m "docs: document sales.item_name, profiles.shortcut_token, and Shortcuts integration"
```

---

## Self-Review

**Spec coverage:**
- [x] `profiles.shortcut_token` column — Task 2
- [x] `sales.item_name` column — Task 1
- [x] Edge function `shortcut_record_sale` with token auth — Task 5
- [x] Settings UI: generate/copy/regenerate token — Task 6 + 7
- [x] "Add to Shortcuts" download link — Task 6 (`/reseller-sale.shortcut`)
- [x] Apple Shortcut: 4 prompts (item name, quantity, price, payment method) — Task 8
- [x] Payment method label→value mapping in shortcut — Task 8 step 2, action 8
- [x] First-run token prompt + persistent storage — Task 8 step 2, actions 1–3
- [x] Success notification / error alert — Task 8 step 2, action 10
- [x] `item_name` visible in sales list for unlinked sales — Task 4
- [x] Docs updated — Task 9

**Types consistent:** `Sale.item_name?: string | null` defined in Task 3, used in Task 4 (`sale.item_name`), inserted in Task 5 edge function as `item_name: item_name.trim()`. All consistent.

**No placeholders:** All code is complete. The only manual step is building the `.shortcut` file in the Shortcuts app — this cannot be generated programmatically from the binary plist format.
