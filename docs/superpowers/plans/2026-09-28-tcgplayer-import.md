# TCGPlayer Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import TCGPlayer sales with exact fee data using a Tampermonkey userscript that calls TCGPlayer's internal order-management API, producing a JSON file the app can ingest.

**Architecture:** Tampermonkey script runs on `seller.tcgplayer.com`, paginates `POST /orders/search`, detail-fetches each order for `feeAmount`/`netAmount`, downloads a JSON file. A new edge function `import_tcgplayer_orders` accepts that JSON and upserts rows directly into `sales` (same pattern as eBay Order Earnings — no `transactions` intermediate). The existing `CSVImportCard` component handles the upload UI with a minor `accept` prop addition.

**Tech Stack:** Deno edge function, `@supabase/supabase-js@2`, React 19, TanStack Query, Tailwind v4, Tampermonkey userscript (vanilla JS)

**Spec:** `docs/superpowers/specs/2026-09-28-tcgplayer-import-design.md`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `tampermonkey/tcgplayer-export.user.js` | Tampermonkey script: fetch all orders + fees, download JSON |
| Create | `supabase/functions/import_tcgplayer_orders/index.ts` | Edge function: parse JSON, upsert into `sales` |
| Modify | `src/lib/types.ts` | Add `TcgPlayerImportResult` type |
| Modify | `src/lib/mutations.ts` | Add `importTCGPlayerOrders(file)` |
| Modify | `src/pages/SettingsPage.tsx` | Add state + handler + upload card; add `accept` prop to `CSVImportCard` |
| Modify | `docs/features/settings.md` | Document new TCGPlayer card |
| Modify | `docs/supabase-schema.md` | Note `tcgplayer` source is now active |

---

## Task 1: Tampermonkey script

**Files:**
- Create: `tampermonkey/tcgplayer-export.user.js`

- [ ] **Step 1: Create the script file**

```javascript
// ==UserScript==
// @name         TCGPlayer Export for Reseller Dashboard
// @namespace    https://seller.tcgplayer.com
// @version      1.0
// @description  Export TCGPlayer orders with fee data for Reseller Dashboard import
// @match        https://seller.tcgplayer.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict'

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  // Your seller key: lowercase prefix of any order number.
  // e.g. order "AE18D02E-28AA51-BAA99" → seller key is "ae18d02e"
  const SELLER_KEY = 'REPLACE_WITH_YOUR_SELLER_KEY'

  const PAGE_SIZE = 100
  const BASE = 'https://order-management-api.tcgplayer.com'

  // ── API helpers ─────────────────────────────────────────────────────────────

  async function fetchAllOrders(searchRange) {
    const orders = []
    let from = 0
    let total = Infinity
    while (from < total) {
      const res = await fetch(`${BASE}/orders/search?api-version=2.0`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchRange,
          filters: { sellerKey: SELLER_KEY },
          sortBy: [{ sortingType: 'orderDate', direction: 'ascending' }],
          from,
          size: PAGE_SIZE,
        }),
      })
      if (!res.ok) throw new Error(`Search failed: ${res.status}`)
      const data = await res.json()
      total = data.totalOrders ?? 0
      orders.push(...(data.orders ?? []))
      from += PAGE_SIZE
    }
    return orders
  }

  async function fetchOrderDetail(orderNumber) {
    const res = await fetch(`${BASE}/orders/${orderNumber}?api-version=2.0`, {
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`Detail fetch failed for ${orderNumber}: ${res.status}`)
    return res.json()
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // ── Export flow ─────────────────────────────────────────────────────────────

  async function exportOrders() {
    const choice = prompt(
      'Export date range:\n1 = Last 3 months\n2 = Last 6 months\n3 = Last year',
      '1'
    )
    if (choice === null) return // user cancelled
    const rangeMap = { '1': 'LastThreeMonths', '2': 'LastSixMonths', '3': 'LastYear' }
    const searchRange = rangeMap[choice] ?? 'LastThreeMonths'

    const btn = document.getElementById('rdb-tcg-export')
    btn.textContent = 'Fetching order list…'
    btn.disabled = true

    try {
      const orders = await fetchAllOrders(searchRange)
      const enriched = []

      for (let i = 0; i < orders.length; i++) {
        btn.textContent = `Fetching order ${i + 1} of ${orders.length}…`
        const detail = await fetchOrderDetail(orders[i].orderNumber)
        enriched.push({
          orderNumber: detail.orderNumber,
          orderDate: detail.createdAt,
          orderStatus: detail.status,
          productAmount: detail.transaction?.productAmount ?? 0,
          shippingAmount: detail.transaction?.shippingAmount ?? 0,
          grossAmount: detail.transaction?.grossAmount ?? 0,
          feeAmount: detail.transaction?.feeAmount ?? 0,
          netAmount: detail.transaction?.netAmount ?? 0,
          refundStatus: detail.refundStatus ?? '',
          refunds: detail.refunds ?? [],
        })
        // ~3 req/sec throttle
        if ((i + 1) % 3 === 0) await sleep(1000)
      }

      const filename = `tcgplayer-orders-${new Date().toISOString().slice(0, 10)}.json`
      const blob = new Blob([JSON.stringify(enriched, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)

      btn.textContent = `✓ Exported ${enriched.length} orders`
    } catch (err) {
      btn.textContent = 'Export failed — see console'
      console.error('[RDB TCGPlayer Export]', err)
    } finally {
      btn.disabled = false
    }
  }

  // ── UI injection ─────────────────────────────────────────────────────────────

  function injectButton() {
    if (document.getElementById('rdb-tcg-export')) return
    const btn = document.createElement('button')
    btn.id = 'rdb-tcg-export'
    btn.textContent = 'Export for Reseller Dashboard'
    btn.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:9999',
      'background:#2563eb', 'color:#fff', 'border:none', 'border-radius:6px',
      'padding:10px 16px', 'font-size:14px', 'font-weight:500', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,0.2)',
    ].join(';')
    btn.addEventListener('click', exportOrders)
    document.body.appendChild(btn)
  }

  window.addEventListener('load', injectButton)
  // Re-inject after SPA navigation
  new MutationObserver(() => {
    if (!document.getElementById('rdb-tcg-export')) injectButton()
  }).observe(document.body, { childList: true, subtree: false })
})()
```

- [ ] **Step 2: Edit SELLER_KEY**

Open `tampermonkey/tcgplayer-export.user.js`, replace `'REPLACE_WITH_YOUR_SELLER_KEY'` with your actual seller key (e.g. `'ae18d02e'`). It is the lowercase version of the first segment of any order number.

- [ ] **Step 3: Install in Tampermonkey and manual-test**

1. Open Tampermonkey → Dashboard → + (new script).
2. Paste the full file content, save.
3. Visit `https://seller.tcgplayer.com/` — confirm blue "Export for Reseller Dashboard" button appears in bottom-right.
4. Click it, pick "1" (Last 3 months). Watch the progress counter. After completion a `.json` file downloads.
5. Open the JSON and verify: array of objects with `orderNumber`, `feeAmount`, `netAmount` populated (not 0 on a Completed-Paid order).

- [ ] **Step 4: Commit**

```bash
git add tampermonkey/tcgplayer-export.user.js
git commit -m "feat: add TCGPlayer Tampermonkey export script"
```

---

## Task 2: Edge function `import_tcgplayer_orders`

**Files:**
- Create: `supabase/functions/import_tcgplayer_orders/index.ts`

- [ ] **Step 1: Create the edge function**

```typescript
// supabase/functions/import_tcgplayer_orders/index.ts
// v1 — Import TCGPlayer orders from Tampermonkey export JSON.
// Upserts directly into `sales` table (same as eBay Order Earnings path).
// Skips Canceled orders. Maps refundStatus → return_status.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const BATCH = 200

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

type TcgOrder = {
  orderNumber: string
  orderDate: string       // ISO 8601 e.g. "2026-09-26T01:25:13.767Z"
  orderStatus: string     // "Completed - Paid" | "Ready to Ship" | "Canceled"
  productAmount: number
  shippingAmount: number
  grossAmount: number
  feeAmount: number
  netAmount: number
  refundStatus: string    // "" | "FullRefund" | "PartialRefund"
  refunds: unknown[]
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return json(401, { error: 'Unauthorized' })

    const body = await req.json()
    const orders: TcgOrder[] = body.orders
    if (!Array.isArray(orders)) return json(400, { error: 'Body must be { orders: TcgOrder[] }' })

    const salesRows: Record<string, unknown>[] = []
    let skipped = 0

    for (const o of orders) {
      if (o.orderStatus === 'Canceled') { skipped++; continue }

      const rs = (o.refundStatus ?? '').toLowerCase()
      const returnStatus = rs.includes('full') ? 'full' : rs.includes('partial') ? 'partial' : 'none'

      salesRows.push({
        user_id: user.id,
        platform: 'tcgplayer',
        source: 'tcgplayer',
        external_order_id: o.orderNumber,
        sale_price: o.productAmount,
        shipping_cost: o.shippingAmount,
        fees: o.feeAmount,
        net_payout: o.netAmount,
        return_status: returnStatus,
        sold_at: o.orderDate.slice(0, 10),
        inventory_status: 'ok',
        refunded_quantity: 0,
        deleted_at: null,
      })
    }

    let upserted = 0
    for (let i = 0; i < salesRows.length; i += BATCH) {
      const batch = salesRows.slice(i, i + BATCH)
      const { error } = await supabase
        .from('sales')
        .upsert(batch, { onConflict: 'user_id,external_order_id' })
      if (error) {
        console.error('Sales upsert error:', error)
      } else {
        upserted += batch.length
      }
    }

    return json(200, { platform: 'tcgplayer', sales_upserted: upserted, skipped })
  } catch (error: unknown) {
    console.error('Import error:', error)
    return json(500, { error: error instanceof Error ? error.message : 'Unknown error' })
  }
})
```

- [ ] **Step 2: Deploy the edge function**

```bash
npx supabase functions deploy import_tcgplayer_orders
```

Expected output:
```
Deploying Function import_tcgplayer_orders...
Done: https://<project>.supabase.co/functions/v1/import_tcgplayer_orders
```

- [ ] **Step 3: Smoke-test via curl**

Replace `<SUPABASE_URL>`, `<ANON_KEY>`, and `<JWT>` with your project values (JWT from browser DevTools → Application → localStorage → `sb-*-auth-token`).

```bash
curl -s -X POST \
  '<SUPABASE_URL>/functions/v1/import_tcgplayer_orders' \
  -H 'Authorization: Bearer <JWT>' \
  -H 'Content-Type: application/json' \
  -d '{"orders":[{"orderNumber":"TCG-TEST-001","orderDate":"2026-09-01T00:00:00Z","orderStatus":"Completed - Paid","productAmount":10.00,"shippingAmount":0,"grossAmount":10.00,"feeAmount":1.90,"netAmount":8.10,"refundStatus":"","refunds":[]}]}' \
  | jq
```

Expected response:
```json
{ "platform": "tcgplayer", "sales_upserted": 1, "skipped": 0 }
```

Verify the row in Supabase → Table Editor → `sales` with `external_order_id = 'TCG-TEST-001'`.

- [ ] **Step 4: Delete test row**

```bash
# In Supabase Table Editor or SQL editor:
# DELETE FROM sales WHERE external_order_id = 'TCG-TEST-001';
```

Run in Supabase SQL editor:
```sql
DELETE FROM sales WHERE external_order_id = 'TCG-TEST-001';
```

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/import_tcgplayer_orders/index.ts
git commit -m "feat: add import_tcgplayer_orders edge function"
```

---

## Task 3: Type + Mutation

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/mutations.ts`

- [ ] **Step 1: Add `TcgPlayerImportResult` to `src/lib/types.ts`**

After the `CSVSaleSyncResult` type (around line 280), add:

```typescript
export type TcgPlayerImportResult = {
  platform: 'tcgplayer'
  sales_upserted: number
  skipped: number
}
```

- [ ] **Step 2: Add `importTCGPlayerOrders` to `src/lib/mutations.ts`**

Add the import at the top of the file (after the existing type imports):
```typescript
import type { Item, InventoryLot, LotAdjustmentType, CSVImportResult, CSVSaleSyncResult, TcgPlayerImportResult, FindOrphansResult } from './types'
```

Then add the function after `syncCSVOrders` (around line 2135):

```typescript
export async function importTCGPlayerOrders(file: File): Promise<TcgPlayerImportResult> {
  const text = await file.text()
  const orders = JSON.parse(text)
  const { data, error } = await supabase.functions.invoke('import_tcgplayer_orders', {
    body: { orders },
  })
  if (error) throw error
  return data as TcgPlayerImportResult
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/mutations.ts
git commit -m "feat: add importTCGPlayerOrders mutation and TcgPlayerImportResult type"
```

---

## Task 4: Settings UI

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add `accept` prop to `CSVImportCard`**

Find the `CSVImportCardProps` type (around line 641) and add `accept?`:

```typescript
type CSVImportCardProps = {
  platform: string
  label: string
  description: string
  state: ImportState
  inputRef: React.RefObject<HTMLInputElement>
  onPick: () => void
  onFile: (file: File) => void
  onReset: () => void
  accept?: string
}
```

Find the function signature for `CSVImportCard` and destructure `accept`:

```typescript
function CSVImportCard({ platform: _platform, label, description, state, inputRef, onPick, onFile, onReset, accept = '.csv' }: CSVImportCardProps) {
```

Find `accept=".csv"` in the `<input>` element inside `CSVImportCard` and replace it:

```tsx
accept={accept}
```

- [ ] **Step 2: Add TCGPlayer import state and ref**

In `SettingsPage`, after line 59 (`const [ebayOEState, ...`), add:

```typescript
const [tcgState, setTcgState] = useState<ImportState>({ phase: 'idle' })
```

After line 64 (`const ebayOERef = ...`), add:

```typescript
const tcgRef = useRef<HTMLInputElement>(null)
```

- [ ] **Step 3: Add `importTCGPlayerOrders` to the imports at the top of the file**

Find the existing line (around line 17):
```typescript
import { importMarketplaceCSV, syncCSVOrders, linkCSVGroupToSettlement } from '../lib/mutations'
```
Replace with:
```typescript
import { importMarketplaceCSV, syncCSVOrders, linkCSVGroupToSettlement, importTCGPlayerOrders } from '../lib/mutations'
```

Also add `TcgPlayerImportResult` to the types import:
```typescript
import type { CSVImportResult, CSVSaleSyncResult, FindOrphansResult, TcgPlayerImportResult } from '../lib/types'
```

- [ ] **Step 4: Add `handleTCGImport` handler**

After the closing brace of `handleImport` (around line 131), add:

```typescript
async function handleTCGImport(file: File) {
  setTcgState({ phase: 'importing' })
  try {
    const result: TcgPlayerImportResult = await importTCGPlayerOrders(file)
    setTcgState({
      phase: 'done',
      importResult: {
        platform: 'tcgplayer',
        rows_parsed: result.sales_upserted + result.skipped,
        rows_skipped: result.skipped,
        sales_upserted: result.sales_upserted,
      },
      syncResult: { created: result.sales_upserted, updated: 0, removed: 0 },
    })
    qc.invalidateQueries({ queryKey: ['sales'] })
  } catch (e: unknown) {
    console.error('TCGPlayer import error:', e)
    setTcgState({ phase: 'error', message: e instanceof Error ? e.message : 'Import failed' })
  }
}
```

- [ ] **Step 5: Add TCGPlayer upload card to the Marketplace CSV Import section**

Find the closing `</div>` after the Mercari `CSVImportCard` (around line 482):

```tsx
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
```

Replace with:

```tsx
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
          <CSVImportCard
            platform="tcgplayer"
            label="TCGPlayer"
            description="Install the TCGPlayer userscript, then upload the exported JSON"
            state={tcgState}
            inputRef={tcgRef}
            onPick={() => tcgRef.current?.click()}
            onFile={handleTCGImport}
            onReset={() => setTcgState({ phase: 'idle' })}
            accept=".json"
          />
        </div>
```

- [ ] **Step 6: Verify build and visual check**

```bash
npm run build 2>&1 | head -20
```

Then:
```bash
npm run dev
```

Open `http://localhost:5173/settings`. Confirm:
- "TCGPlayer" card appears below "Mercari"
- Clicking "Upload" opens a file picker that shows `.json` files
- Uploading the JSON from Task 1 Step 5 shows "importing…" then a success count

- [ ] **Step 7: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat: add TCGPlayer import card to Settings"
```

---

## Task 5: Docs

**Files:**
- Modify: `docs/features/settings.md`
- Modify: `docs/supabase-schema.md`

- [ ] **Step 1: Update `docs/features/settings.md`**

In the Marketplace CSV Import section, add TCGPlayer:

```markdown
### TCGPlayer
Upload the JSON exported by the TCGPlayer Tampermonkey userscript
(`tampermonkey/tcgplayer-export.user.js`). The script calls TCGPlayer's internal
order-management API to get exact fee and net payout per order, then downloads a
JSON file. Upload that file here.

- Upserts directly into `sales` (no `transactions` intermediate, no sync step).
- `source = 'tcgplayer'`, `external_order_id = orderNumber`.
- Canceled orders are skipped. `refundStatus` maps to `return_status`.
- Re-import safe: upsert on `(user_id, external_order_id)`.
- No settlement/payout matching (TCGPlayer pays Mon/Thu but exposes no payout ID).
```

- [ ] **Step 2: Update `docs/supabase-schema.md`**

Find the note about `sales.source` CHECK constraint and update the note to indicate `tcgplayer` is now actively used:

Add after the constraint listing or in the notes for the `sales` table:
```
`source = 'tcgplayer'` — active as of 2026-09-28. Set by `import_tcgplayer_orders` edge function.
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/settings.md docs/supabase-schema.md
git commit -m "docs: document TCGPlayer import in settings and schema docs"
```
