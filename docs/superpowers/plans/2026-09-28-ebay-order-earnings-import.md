# eBay Order Earnings Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import eBay Order Earnings CSV as the primary source for `sales` rows — provides per-order shipping label costs, itemized fee breakdown, discounts, and refunds. Transaction Report remains the source for `transactions` (settlement matching).

**Architecture:** Add `fee_breakdown` JSONB and `discount` numeric columns to `sales`. New `ebay_order_earnings` platform branch in `import_marketplace_csv` parses Order Earnings CSV, groups by order number, and upserts directly to `sales` (using existing unique index on `user_id, external_order_id`). Disable `sync_csv_orders_to_sales` for eBay. Add second upload card in Settings. Show itemized fees in sales detail.

**Tech Stack:** Supabase (SQL migration + Deno edge function), TypeScript, React 19, TanStack React Query, Tailwind v4.

---

## Files

| Action | File |
|---|---|
| Create | `supabase/migrations/20260928130000_sales_fee_breakdown.sql` |
| Modify | `src/lib/types.ts` — add `fee_breakdown`, `discount` to `Sale` |
| Modify | `supabase/functions/import_marketplace_csv/index.ts` — add `ebay_order_earnings` parser |
| Modify | `supabase/functions/sync_csv_orders_to_sales/index.ts` — skip eBay |
| Modify | `src/pages/SettingsPage.tsx` — add Order Earnings upload card |
| Modify | `src/pages/SalesPage.tsx` — fee breakdown in sale detail |

---

### Task 1: Migration — add `fee_breakdown` and `discount` columns to `sales`

**Files:**
- Create: `supabase/migrations/20260928130000_sales_fee_breakdown.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260928130000_sales_fee_breakdown.sql
-- Itemized fee breakdown from eBay Order Earnings import.
-- fee_breakdown stores per-fee-type amounts as JSONB; discount is a simple scalar.
-- Existing sales (manual, Amazon, etc.) keep these null — display falls back to
-- the existing summed `fees` column.

alter table public.sales
  add column fee_breakdown jsonb default null;

alter table public.sales
  add column discount numeric default null;

comment on column public.sales.fee_breakdown is
  'Per-fee-type breakdown from eBay Order Earnings. Keys: final_value_fee_fixed, '
  'final_value_fee_variable, promoted_listing_standard, regulatory_operating, '
  'international, below_standard_performance, item_not_as_described, '
  'deposit_processing, payment_dispute, charity_donation. Values are positive amounts.';

comment on column public.sales.discount is
  'Discount amount from eBay Order Earnings (positive number). Null when no discount.';
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

Run via `mcp__supabase__apply_migration` or SQL editor:
```sql
alter table public.sales
  add column fee_breakdown jsonb default null;

alter table public.sales
  add column discount numeric default null;
```

- [ ] **Step 3: Verify**

```sql
select column_name, data_type from information_schema.columns
where table_name = 'sales' and column_name in ('fee_breakdown', 'discount');
```

Expected: two rows — `fee_breakdown` (jsonb) and `discount` (numeric).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260928130000_sales_fee_breakdown.sql
git commit -m "feat: add fee_breakdown JSONB and discount columns to sales"
```

---

### Task 2: Update `Sale` TypeScript type

**Files:**
- Modify: `src/lib/types.ts` (lines 46–85 — the `Sale` interface)

- [ ] **Step 1: Add `fee_breakdown`, `discount`, and `'ebay'` source to `Sale`**

Open `src/lib/types.ts`. Find the `Sale` interface (line 46). Make these changes:

1. On line 52, update the `source` union to include `'ebay'`:
```typescript
  source: 'manual' | 'csv_import' | 'plaid' | 'trade' | 'ebay'
```

2. After `shipping_cost` (line 56), add two new fields:
```typescript
  shipping_cost?: number
  /** Itemized fee breakdown from eBay Order Earnings. Null for non-eBay sales. */
  fee_breakdown?: Record<string, number> | null
  /** Discount amount from eBay Order Earnings. Null when no discount. */
  discount?: number | null
  net_payout?: number
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add fee_breakdown, discount, and ebay source to Sale type"
```

---

### Task 3: Order Earnings parser in `import_marketplace_csv`

**Files:**
- Modify: `supabase/functions/import_marketplace_csv/index.ts`

This is the core task. Add an `ebay_order_earnings` branch that parses Order Earnings CSV, groups rows by order number, and upserts directly to the `sales` table. Returns early — no `transactions` upsert.

**Context for implementer:** The function structure is:
```
if (platform === 'amazon') { ... build transactions[] ... }
else if (platform === 'ebay') { ... build transactions[] ... }
else if (platform === 'mercari') { ... build transactions[] ... }
else { error: Unknown platform }

// Shared: batch upsert transactions[]
for (...) { supabase.from('transactions').upsert(...) }
return Response(...)
```

The Order Earnings branch must `return` its own `Response` before reaching the shared transactions upsert, since it writes to `sales`, not `transactions`.

Existing helpers available: `parseCSV(text)` parses the CSV into `string[][]`. `parseDateAny(str)` parses dates like `"Jan 3, 2025"` into `YYYY-MM-DD`. `parseAmount(str)` parses `"37.9"` or `"-0.40"` or `"--"` into a number (0 for `--`). `notDash(str)` returns null for `--`/empty.

The `sales` table has a unique index `sales_ebay_api_order_dedup ON (user_id, external_order_id)` — use it for upsert.

Existing `sales_source_check` constraint allows: `'manual', 'amazon', 'ebay', 'tcgplayer', 'csv_import', 'trade'`. Use `source: 'ebay'`.

- [ ] **Step 1: Add the `ebay_order_earnings` branch**

Find the `} else if (platform === 'mercari') {` block. After the closing `}` of the mercari block (and before the `else { return ... Unknown platform }` block), insert:

```typescript
    // ──────────────────────────────
    // EBAY — Order Earnings Report → sales table (not transactions)
    // ──────────────────────────────
    } else if (platform === 'ebay_order_earnings') {
      let headerIdx = -1
      for (let i = 0; i < allRows.length; i++) {
        const norm = allRows[i].map(h => h.replace(/"/g, '').trim().toLowerCase())
        if (norm.includes('order creation date') && norm.includes('order earnings')) {
          headerIdx = i; break
        }
      }
      if (headerIdx === -1) {
        return new Response(JSON.stringify({
          error: 'Could not find Order Earnings header row. Expected columns: "Order creation date" and "Order earnings". Use: Seller Hub → Reports → Order Earnings Report.',
        }), { status: 400 })
      }

      const header = allRows[headerIdx].map(h => h.replace(/"/g, '').trim())
      const col = (row: string[], name: string) => {
        const idx = header.findIndex(h => h.toLowerCase() === name.toLowerCase())
        return idx !== -1 ? (row[idx]?.replace(/"/g, '').trim() ?? '') : ''
      }

      // Group rows by Order number
      const orders = new Map<string, {
        date: string
        itemTitles: string[]
        totalQty: number
        grossAmount: number
        fees: Record<string, number>
        shippingLabels: number
        discount: number
        refunds: number
        orderEarnings: number
      }>()

      const FEE_COLS = [
        ['Final Value Fee - fixed', 'final_value_fee_fixed'],
        ['Final Value Fee - variable', 'final_value_fee_variable'],
        ['Promoted Listing Standard fee', 'promoted_listing_standard'],
        ['Regulatory operating fee', 'regulatory_operating'],
        ['International fee', 'international'],
        ['Below standard performance fee', 'below_standard_performance'],
        ['Very high item not as described fee', 'item_not_as_described'],
        ['Deposit processing fee', 'deposit_processing'],
        ['Payment Dispute Fee', 'payment_dispute'],
        ['Charity donation', 'charity_donation'],
      ] as const

      for (let i = headerIdx + 1; i < allRows.length; i++) {
        const r = allRows[i]
        const orderNumber = col(r, 'Order number')
        if (!orderNumber || orderNumber === '--') { trackSkip('no_order_number'); continue }

        const date = parseDateAny(col(r, 'Order creation date'))
        if (!date) { trackSkip('bad_date'); continue }

        const grossAmount = parseAmount(col(r, 'Gross amount'))
        const orderEarnings = parseAmount(col(r, 'Order earnings'))
        const qty = parseInt(col(r, 'Quantity')) || 1
        const itemTitle = col(r, 'Item title')
        const shippingLabels = Math.abs(parseAmount(col(r, 'Shipping labels')))
        const discount = Math.abs(parseAmount(col(r, 'Discount')))
        const refunds = Math.abs(parseAmount(col(r, 'Refunds')))

        const rowFees: Record<string, number> = {}
        for (const [csvName, key] of FEE_COLS) {
          rowFees[key] = Math.abs(parseAmount(col(r, csvName)))
        }

        const existing = orders.get(orderNumber)
        if (existing) {
          existing.itemTitles.push(itemTitle)
          existing.totalQty += qty
          existing.grossAmount += grossAmount
          for (const key of Object.keys(rowFees)) existing.fees[key] = (existing.fees[key] ?? 0) + rowFees[key]
          existing.shippingLabels += shippingLabels
          existing.discount += discount
          existing.refunds += refunds
          existing.orderEarnings += orderEarnings
        } else {
          orders.set(orderNumber, {
            date, itemTitles: [itemTitle], totalQty: qty, grossAmount,
            fees: { ...rowFees }, shippingLabels, discount, refunds, orderEarnings,
          })
        }
        rowsParsed++
      }

      // Build and upsert sales rows
      const salesRows: any[] = []
      for (const [orderNumber, e] of orders) {
        const feesTotal = Object.values(e.fees).reduce((s, v) => s + v, 0)
        const itemName = e.itemTitles.length === 1
          ? (e.itemTitles[0] || 'eBay Sale')
          : `${e.itemTitles[0]} + ${e.itemTitles.length - 1} more`

        salesRows.push({
          user_id: user.id,
          platform: 'ebay',
          source: 'ebay',
          external_order_id: orderNumber,
          item_name: itemName,
          quantity: e.totalQty,
          sale_price: e.grossAmount,
          fees: feesTotal,
          fee_breakdown: e.fees,
          shipping_cost: e.shippingLabels,
          discount: e.discount > 0 ? e.discount : null,
          net_payout: e.orderEarnings,
          refunded_amount: e.refunds > 0 ? e.refunds : 0,
          return_status: e.refunds > 0 ? (e.refunds >= e.grossAmount ? 'full' : 'partial') : 'none',
          sold_at: e.date,
          inventory_status: 'ok',
          refunded_quantity: 0,
        })
      }

      let salesUpserted = 0
      for (let i = 0; i < salesRows.length; i += BATCH) {
        const { error, count } = await supabase.from('sales')
          .upsert(salesRows.slice(i, i + BATCH), { onConflict: 'user_id,external_order_id' })
        if (error) console.error('Sales upsert error:', error)
        else salesUpserted += salesRows.slice(i, i + BATCH).length
      }

      return new Response(JSON.stringify({
        success: true, platform: 'ebay_order_earnings',
        rows_parsed: rowsParsed, rows_skipped: rowsSkipped,
        skipped_breakdown: skippedTypes,
        sales_upserted: salesUpserted,
      }), { headers: { 'Content-Type': 'application/json' } })
```

- [ ] **Step 2: Update the "Unknown platform" error message**

Find:
```typescript
      return new Response(JSON.stringify({ error: `Unknown platform: ${platform}. Supported: ebay, amazon, mercari` }), { status: 400 })
```

Replace with:
```typescript
      return new Response(JSON.stringify({ error: `Unknown platform: ${platform}. Supported: ebay, ebay_order_earnings, amazon, mercari` }), { status: 400 })
```

- [ ] **Step 3: Update the version comment at the top of the file**

Find:
```typescript
// import_marketplace_csv v18
```

Replace with:
```typescript
// import_marketplace_csv v19
// Add: eBay Order Earnings Report parser. Writes directly to `sales` table
//      (not `transactions`) with per-order fee breakdown, shipping label cost,
//      discount, and refund data. Groups multi-item orders into one sale row.
//      Uses existing unique index (user_id, external_order_id) for idempotent
//      upsert on overlapping date ranges.
// Prior: import_marketplace_csv v18
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/import_marketplace_csv/index.ts
git commit -m "feat: add eBay Order Earnings parser to import_marketplace_csv (v19)"
```

---

### Task 4: `sync_csv_orders_to_sales` — skip eBay

**Files:**
- Modify: `supabase/functions/sync_csv_orders_to_sales/index.ts`

Order Earnings is now the primary sales source for eBay. The sync function should no longer create sales rows from eBay Transaction Report transactions.

- [ ] **Step 1: Add early return for eBay**

Find the line after the auth check and `platform` extraction (around line 30):
```typescript
    const body = await req.json()
    const platform: string = body.platform
    if (!platform) return json(400, { error: "Missing platform" })
```

Add immediately after:
```typescript
    // eBay sales come from Order Earnings import (import_marketplace_csv v19),
    // not from Transaction Report transactions. Skip sync for eBay.
    if (platform === "ebay") {
      return json(200, { created: 0, updated: 0, removed: 0 })
    }
```

- [ ] **Step 2: Update the version comment**

Find:
```typescript
// sync_csv_orders_to_sales v1
```

Replace with:
```typescript
// sync_csv_orders_to_sales v2
// Change: skip eBay — Order Earnings import writes directly to sales.
// Prior: sync_csv_orders_to_sales v1
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/sync_csv_orders_to_sales/index.ts
git commit -m "feat: skip eBay in sync_csv_orders_to_sales (v2) — Order Earnings is primary"
```

---

### Task 5: Settings UI — Order Earnings upload card

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

Add a second eBay upload card for Order Earnings. Modify `handleImport` to skip the sync step for `ebay_order_earnings`.

- [ ] **Step 1: Add `CSVImportResult.sales_upserted` to types**

Open `src/lib/types.ts`. Find the `CSVImportResult` interface. Add:

```typescript
  sales_upserted?: number
```

If `CSVImportResult` is not in `types.ts`, search for it — it may be defined inline in `SettingsPage.tsx` or `mutations.ts`. Add `sales_upserted?: number` to whichever file defines it.

- [ ] **Step 2: Add Order Earnings state and ref**

In `src/pages/SettingsPage.tsx`, find (around line 50–56):
```typescript
  const [ebayState, setEbayState] = useState<ImportState>({ phase: 'idle' })
  const [amazonState, setAmazonState] = useState<ImportState>({ phase: 'idle' })
  const [mercariState, setMercariState] = useState<ImportState>({ phase: 'idle' })

  const ebayRef = useRef<HTMLInputElement>(null)
  const amazonRef = useRef<HTMLInputElement>(null)
  const mercariRef = useRef<HTMLInputElement>(null)
```

Add after `mercariState` and `mercariRef`:
```typescript
  const [ebayOEState, setEbayOEState] = useState<ImportState>({ phase: 'idle' })
  const ebayOERef = useRef<HTMLInputElement>(null)
```

- [ ] **Step 3: Modify `handleImport` to skip sync for Order Earnings**

Find `handleImport` (lines 99–115). Replace with:

```typescript
  async function handleImport(
    platform: string,
    file: File,
    setState: (s: ImportState) => void,
  ) {
    setState({ phase: 'importing' })
    try {
      const importResult = await importMarketplaceCSV(platform, file)
      if (platform === 'ebay_order_earnings') {
        // Order Earnings writes directly to sales — no sync step
        const count = (importResult as any).sales_upserted ?? 0
        setState({ phase: 'done', importResult, syncResult: { created: count, updated: 0, removed: 0 } })
      } else {
        setState({ phase: 'syncing', importResult })
        const syncResult = await syncCSVOrders(platform)
        setState({ phase: 'done', importResult, syncResult })
      }
      qc.invalidateQueries({ queryKey: ['csv-groups', platform] })
      qc.invalidateQueries({ queryKey: ['sales'] })
    } catch (e: unknown) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : 'Import failed' })
    }
  }
```

- [ ] **Step 4: Add Order Earnings `CSVImportCard` in the template**

Find the eBay `CSVImportCard` (lines 395–404):
```tsx
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
```

Add immediately after (before the Amazon card):
```tsx
          <CSVImportCard
            platform="ebay_order_earnings"
            label="eBay Order Earnings"
            description="Seller Hub → Reports → Order Earnings Report"
            state={ebayOEState}
            inputRef={ebayOERef}
            onPick={() => ebayOERef.current?.click()}
            onFile={file => handleImport('ebay_order_earnings', file, setEbayOEState)}
            onReset={() => setEbayOEState({ phase: 'idle' })}
          />
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6: Run tests**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: 78 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/pages/SettingsPage.tsx
git commit -m "feat: add eBay Order Earnings upload card in Settings"
```

---

### Task 6: Sales detail — fee breakdown display

**Files:**
- Modify: `src/pages/SalesPage.tsx` (lines 316–344 — the Profitability section)

When `fee_breakdown` is present, show each non-zero fee on its own line instead of a single "Fees" line. Also show discount when present.

- [ ] **Step 1: Add fee label map constant**

At the top of `SalesPage.tsx`, after the imports and before the component functions, add:

```typescript
const FEE_LABELS: Record<string, string> = {
  final_value_fee_fixed: 'FVF (fixed)',
  final_value_fee_variable: 'FVF (variable)',
  promoted_listing_standard: 'Promoted Listing',
  regulatory_operating: 'Regulatory',
  international: 'International',
  below_standard_performance: 'Below Standard',
  item_not_as_described: 'INAD Fee',
  deposit_processing: 'Deposit Processing',
  payment_dispute: 'Payment Dispute',
  charity_donation: 'Charity',
}
```

- [ ] **Step 2: Replace the Profitability section**

Find the Profitability section in `SaleDetail` (lines 316–344):
```tsx
      {/* Profitability */}
      {hasCogsData && (
        <div className="bg-gray-50 rounded-xl p-4">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Profitability</div>
          {[
            { label: 'Revenue', value: netRevenue },
            { label: 'COGS', value: -cogs },
            { label: 'Fees', value: -displayFees },
            { label: 'Shipping', value: -(displayShipping ?? 0) },
          ].map(({ label, value }) => (
            <div key={label} className="flex justify-between py-0.5 text-xs">
              <span className="text-gray-600">{label}</span>
              <span className={`tabular-nums font-medium ${value < 0 ? 'text-red-500' : 'text-gray-800'}`}>
                {formatUSD(value)}
              </span>
            </div>
          ))}
          <div className="flex justify-between pt-2 border-t border-gray-200 mt-1 text-sm">
            <span className="font-semibold text-gray-900">Net Profit</span>
            <span className={`font-bold tabular-nums ${profit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {formatUSD(profit)}
            </span>
          </div>
          {netRevenue > 0 && (
            <div className="text-xs text-gray-400 text-right mt-0.5">
              {((profit / netRevenue) * 100).toFixed(1)}% margin
            </div>
          )}
        </div>
      )}
```

Replace with:
```tsx
      {/* Profitability */}
      {hasCogsData && (() => {
        const feeLines = sale.fee_breakdown
          ? Object.entries(sale.fee_breakdown)
              .filter(([, v]) => v !== 0)
              .map(([key, value]) => ({ label: FEE_LABELS[key] ?? key.replace(/_/g, ' '), value: -Math.abs(value) }))
          : [{ label: 'Fees', value: -displayFees }]

        const profitLines = [
          { label: 'Revenue', value: netRevenue },
          { label: 'COGS', value: -cogs },
          ...feeLines,
          ...(displayShipping != null && displayShipping !== 0 ? [{ label: 'Shipping Label', value: -displayShipping }] : []),
          ...(sale.discount ? [{ label: 'Discount', value: -sale.discount }] : []),
        ]

        return (
          <div className="bg-gray-50 rounded-xl p-4">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Profitability</div>
            {profitLines.map(({ label, value }) => (
              <div key={label} className="flex justify-between py-0.5 text-xs">
                <span className={`${sale.fee_breakdown && label !== 'Revenue' && label !== 'COGS' ? 'text-gray-400 pl-2' : 'text-gray-600'}`}>{label}</span>
                <span className={`tabular-nums font-medium ${value < 0 ? 'text-red-500' : 'text-gray-800'}`}>
                  {formatUSD(value)}
                </span>
              </div>
            ))}
            <div className="flex justify-between pt-2 border-t border-gray-200 mt-1 text-sm">
              <span className="font-semibold text-gray-900">Net Profit</span>
              <span className={`font-bold tabular-nums ${profit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {formatUSD(profit)}
              </span>
            </div>
            {netRevenue > 0 && (
              <div className="text-xs text-gray-400 text-right mt-0.5">
                {((profit / netRevenue) * 100).toFixed(1)}% margin
              </div>
            )}
          </div>
        )
      })()}
```

- [ ] **Step 3: Also show discount in the Sale metrics grid**

Find the sale metrics grid (lines 250–264):
```tsx
      <div className="grid grid-cols-2 gap-2 text-xs">
        {[
          { label: 'Date', value: formatDate(sale.sold_at) },
          { label: 'Quantity', value: String(sale.quantity) },
          { label: 'Platform Fees', value: formatUSD(displayFees) },
          { label: 'Shipping', value: displayShipping != null ? formatUSD(displayShipping) : '—' },
          { label: 'Net Payout', value: formatUSD(netPayout), negative: netPayout < 0 },
          { label: 'Order ID', value: sale.external_order_id || '—' },
        ].map(({ label, value, negative }) => (
```

Replace the array with:
```tsx
        {[
          { label: 'Date', value: formatDate(sale.sold_at) },
          { label: 'Quantity', value: String(sale.quantity) },
          { label: 'Platform Fees', value: formatUSD(displayFees) },
          { label: 'Shipping', value: displayShipping != null ? formatUSD(displayShipping) : '—' },
          ...(sale.discount ? [{ label: 'Discount', value: formatUSD(sale.discount) }] : []),
          { label: 'Net Payout', value: formatUSD(netPayout), negative: netPayout < 0 },
          { label: 'Order ID', value: sale.external_order_id || '—' },
        ].map(({ label, value, negative }) => (
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Run tests**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: 78 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/pages/SalesPage.tsx
git commit -m "feat: show itemized fee breakdown and discount in sale detail"
```

---

### Task 7: Deploy edge functions

**Files:** None (deployment only)

- [ ] **Step 1: Deploy `import_marketplace_csv` v19**

```bash
supabase functions deploy import_marketplace_csv
```

- [ ] **Step 2: Deploy `sync_csv_orders_to_sales` v2**

```bash
supabase functions deploy sync_csv_orders_to_sales
```

- [ ] **Step 3: Verify Order Earnings import works**

In the running app (Settings → Marketplace CSV), upload an Order Earnings CSV. Expected:
- "eBay Order Earnings import complete — N rows imported"
- "N orders added to Sales"
- Sales page shows the imported orders with fee breakdown visible in sale detail

---

## Manual Verification Checklist

After all tasks complete, verify in `npm run dev`:

- [ ] Settings shows two eBay cards: "eBay" (Transaction Report) and "eBay Order Earnings"
- [ ] Upload an Order Earnings CSV → success banner with row count
- [ ] Sales page shows the imported eBay orders
- [ ] Click a sale → detail shows itemized fee breakdown (FVF fixed, FVF variable, Promoted Listing, etc.)
- [ ] Shipping Label cost shown in profitability
- [ ] Discount shown when non-zero
- [ ] Re-upload the same CSV → no duplicates (upsert is idempotent)
- [ ] Upload Transaction Report → imports transactions, does NOT create sales (sync skipped)
- [ ] Settlement Status still works (reads from Transaction Report transactions)
- [ ] Amazon/Mercari import still creates sales via sync (unchanged)
- [ ] Existing manually recorded sales display normally (no fee_breakdown = single "Fees" line)
