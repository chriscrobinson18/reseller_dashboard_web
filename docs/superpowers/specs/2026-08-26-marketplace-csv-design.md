# Marketplace CSV Import Design

_Date: 2026-08-26_

## Goal

Add marketplace CSV import + settlement matching to the web app. Three deliverables:
1. **CSV Import UI** — file upload per platform calling the existing `import_marketplace_csv` edge function (v16)
2. **`sync_csv_orders_to_sales` edge function** — new; runs after every import; creates/updates unlinked `sales` rows from CSV transactions
3. **Settlement Status UI** — eBay + Amazon only; lists settlement groups; lets user link each to the matching Plaid bank deposit

All live in `SettingsPage.tsx` (new sections after Custom Categories).

---

## Architecture

```
User picks file
  → read as text
  → POST import_marketplace_csv { platform, csv_text }
  → show rows_parsed / rows_skipped banner
  → POST sync_csv_orders_to_sales { platform }
  → append created/updated/removed stats to banner

Settlement Status section (separate, always visible if data exists)
  → useCSVGroups(platform) — reads transactions table, groups client-side
  → click group → CSVGroupDetailSlideOver
    → "Find Plaid Match" → search transactions by amount → select → link
```

---

## 1. Edge Function: `sync_csv_orders_to_sales`

**File:** `supabase/functions/sync_csv_orders_to_sales/index.ts`

**Request:**
```json
{ "platform": "ebay" | "amazon" | "mercari" }
```

**Response:**
```json
{ "created": 3, "updated": 1, "removed": 0 }
```

**Auth:** Standard Bearer token pattern (same as other edge functions).

### Logic

```
1. Fetch all csv_import transactions for user + platform
   WHERE csv_group_id IS NOT NULL
   ORDER BY date ASC

2. For each transaction, extract orderRef = tx.notes
   Skip if notes is null, '', or '--'
   Skip if schedule_c_category IN ('transfer', 'balance_adjustment',
     'taxes_licenses', 'settlement')

3. Group by orderRef → accumulate OrderEntry:
   - grossRevenue: sum of payout amounts > 0
   - refundedAmount: abs(sum of payout amounts < 0)
   - fees: abs(sum of commissions_fees amounts)
   - shippingCost: abs(sum of shipping_postage amounts)
   - date: earliest date across payout rows (fallback: any row)
   - productName: merchant of first payout row with amount > 0

4. Filter: only orders where grossRevenue > 0

5. Derived per order:
   - salePrice = grossRevenue - refundedAmount
   - netPayout = salePrice - fees - shippingCost
   - returnStatus:
       refundedAmount === 0           → null   (DB constraint: null | 'partial' | 'full')
       refundedAmount >= grossRevenue → 'full'
       else                           → 'partial'

6. Fetch existing sales for user + platform (including soft-deleted):
   SELECT id, external_order_id, deleted_at
   FROM sales
   WHERE user_id = $user_id
     AND source = $source   -- 'ebay' | 'amazon' | 'csv_import'
     AND platform = $platform
     AND external_order_id IS NOT NULL

   Build Map<orderRef, { id, deleted_at }> (safe — no crash on duplicates)

7. For each order in ordersToSync:
   a. If exists and not soft-deleted → UPDATE sale_price, fees, shipping_cost,
      net_payout, return_status, date
   b. If exists and soft-deleted → UPDATE same fields + set deleted_at = null
   c. If not exists → INSERT new sale row

8. Soft-delete orphans:
   Sales in existing map whose orderRef is NOT in ordersToSync
   → UPDATE deleted_at = now()

9. Return { created, updated, removed }
```

### Sales row shape on insert

```typescript
{
  user_id,
  date,                          // earliest payout date
  sale_price: salePrice,         // gross - refunds
  fees,
  shipping_cost: shippingCost,
  net_payout: netPayout,
  return_status: returnStatus,   // null | 'partial' | 'full'
  quantity: 1,                   // hardcoded; no quantity column on transactions yet
  platform,
  source,                        // 'ebay' | 'amazon' | 'csv_import' (mercari)
  external_order_id: orderRef,
  item_id: null,                 // unlinked; user links via "Link to inventory item"
  item_name: productName ?? null,
}
```

**Note on `source` values:** `'ebay'` and `'amazon'` are in the DB `sales_source_check` constraint. Mercari is not — use `source = 'csv_import'` with `platform = 'mercari'` to avoid a schema migration.

### Mobile bugs fixed in this implementation

| Bug | Fix |
|---|---|
| `shipping_postage` rows unreachable (dead code) | Included in accumulation loop |
| Hardcoded `quantity: 1` | Still 1 (no column yet); documented |
| Crash on duplicate `external_order_id` | Safe Map lookup, no fatal error |

---

## 2. Types (`src/lib/types.ts`)

```typescript
export type CSVImportResult = {
  platform: string
  rows_parsed: number
  rows_skipped: number
  skipped_breakdown?: Record<string, number>
  amazon_format?: string   // 'transaction_view' | 'settlement_report'
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
  priorBalance: number   // carry-in from prior period; computed during buildCSVGroups
}
```

The `Transaction` type also needs these fields if not already present:

```typescript
csv_group_id?: string | null
csv_transaction_id?: string | null
parent_settlement_id?: string | null
```

---

## 3. Queries (`src/lib/queries.ts`)

### `buildCSVGroups(rows, platform): CSVGroup[]`

Pure function — not a hook. Called from `useCSVGroups`.

```typescript
function buildCSVGroups(rows: Transaction[], platform: string): CSVGroup[] {
  // 1. Group rows by csv_group_id
  const map = new Map<string, Transaction[]>()
  for (const tx of rows) {
    if (!tx.csv_group_id) continue
    const arr = map.get(tx.csv_group_id) ?? []
    arr.push(tx)
    map.set(tx.csv_group_id, arr)
  }

  // 2. Build groups, sort oldest-first by transfer row date (for balance chain)
  let groups: CSVGroup[] = [...map.entries()].map(([groupId, transactions]) => ({
    groupId, platform, transactions, priorBalance: 0
  }))
  groups.sort((a, b) => {
    const aDate = getTransferRow(a)?.date ?? a.transactions[0]?.date ?? ''
    const bDate = getTransferRow(b)?.date ?? b.transactions[0]?.date ?? ''
    return aDate.localeCompare(bDate)
  })

  // 3. Propagate closing reserve as priorBalance into next period
  let carry = 0
  for (const g of groups) {
    g.priorBalance = carry
    const reserve = getClosingReserve(g)
    carry = reserve ?? 0
  }

  // 4. Return newest-first for display
  return groups.reverse()
}
```

### CSV group helper functions (pure, exported from `queries.ts`)

```typescript
export function getTransferRow(g: CSVGroup): Transaction | undefined
  // first tx where schedule_c_category === 'transfer'

export function getNonTransferRows(g: CSVGroup): Transaction[]
  // all tx where schedule_c_category !== 'transfer'

export function getExpectedDeposit(g: CSVGroup): number | undefined
  // transferRow ? -transferRow.amount : undefined

export function isLinkedGroup(g: CSVGroup): boolean
  // any tx has parent_settlement_id != null

export function getLinkedSettlementId(g: CSVGroup): string | undefined
  // first non-null parent_settlement_id

export function getNetTotal(g: CSVGroup): number
  // sum of nonTransferRows amounts

export function getAdjustedTotal(g: CSVGroup): number
  // getNetTotal(g) + g.priorBalance

export function getClosingReserve(g: CSVGroup): number | undefined
  // getExpectedDeposit(g) != null
  //   ? getAdjustedTotal(g) - getExpectedDeposit(g)
  //   : undefined
```

### `useCSVGroups(platform: string)`

```typescript
export function useCSVGroups(platform: string) {
  return useQuery({
    queryKey: ['csv-groups', platform],
    queryFn: async () => {
      const { data } = await supabase
        .from('transactions')
        .select('*')
        .eq('source', 'csv_import')
        .eq('platform', platform)
        .not('csv_group_id', 'is', null)
        .order('date', { ascending: false })
      return buildCSVGroups(data ?? [], platform)
    },
  })
}
```

---

## 4. Mutations (`src/lib/mutations.ts`)

```typescript
export async function importMarketplaceCSV(
  platform: string,
  file: File
): Promise<CSVImportResult>
// Reads file as text, POSTs to import_marketplace_csv edge function

export async function syncCSVOrders(
  platform: string
): Promise<CSVSaleSyncResult>
// POSTs to sync_csv_orders_to_sales edge function

export async function markTransactionAsSettlement(
  id: string,
  platform: string
): Promise<void>
// UPDATE transactions
// SET record_type='settlement', schedule_c_category='settlement', platform=$platform
// WHERE id=$id

export async function linkCSVGroupToSettlement(
  groupId: string,
  settlementId: string,
  platform: string
): Promise<void>
// UPDATE transactions SET parent_settlement_id=$settlementId
// WHERE source='csv_import' AND platform=$platform AND csv_group_id=$groupId

export async function unlinkCSVGroup(
  groupId: string,
  platform: string
): Promise<void>
// UPDATE transactions SET parent_settlement_id=null
// WHERE source='csv_import' AND platform=$platform AND csv_group_id=$groupId
```

---

## 5. SettingsPage additions (`src/pages/SettingsPage.tsx`)

### CSV Import section

Positioned after Custom Categories. Three platform cards:

| Platform | What to download |
|---|---|
| eBay | Seller Hub → Payments → Transaction Report |
| Amazon | Seller Central → Reports → Payments → Transaction View |
| Mercari | Profile → My Sales → Download |

Each card has a hidden `<input type="file" accept=".csv">` triggered by an "Import CSV" button.

**Import state machine (independent per platform):**

```typescript
type ImportState =
  | { phase: 'idle' }
  | { phase: 'importing' }
  | { phase: 'syncing'; importResult: CSVImportResult }
  | { phase: 'done'; importResult: CSVImportResult; syncResult: CSVSaleSyncResult }
  | { phase: 'error'; message: string }
```

On file select:
1. Set phase → `'importing'`
2. Call `importMarketplaceCSV(platform, file)` → on success set phase → `'syncing'`
3. Call `syncCSVOrders(platform)` → on success set phase → `'done'`
4. `queryClient.invalidateQueries(['csv-groups', platform])` and `['sales']`
5. On any error → set phase → `'error'`

**Result banner (phases `syncing` and `done`):**
```
✓ eBay import complete — 142 rows imported, 3 skipped
  → 5 orders added to Sales, 2 updated
```

While `syncing`: show spinner + "Syncing sales..." after the import line.

### Settlement Status section

Positioned after CSV Import. eBay + Amazon only.

```typescript
const [settlementPlatform, setSettlementPlatform] = useState<'ebay' | 'amazon'>('ebay')
const { data: groups = [], isLoading } = useCSVGroups(settlementPlatform)
```

**Layout:**
- Section header: "Settlement Status"
- Platform toggle: eBay | Amazon (same button-group style as other toggles in app)
- Summary: "N of M matched" — green if N === M, amber otherwise
- List of group cards, newest-first

**Group card:**
```
[status dot]  eBay Payout — Jan 15–28, 2026
              Expected deposit: $1,234.56 · 12 transactions
              [Needs Match]  or  [✓ Matched]  or  [On Hold]
```

Badge logic:
- `isLinkedGroup(g)` → green "✓ Matched"
- `getExpectedDeposit(g) != null` → amber "Needs Match"
- else → gray "On Hold"

Click → opens `CSVGroupDetailSlideOver`.

**Empty state:** "No {platform} CSV imports found. Import a Transaction Report above."

---

## 6. `CSVGroupDetailSlideOver` (`src/components/CSVGroupDetailSlideOver.tsx`)

Uses the existing `SlideOver` primitive.

```typescript
type Props = {
  group: CSVGroup
  platform: string
  open: boolean
  onClose: () => void
  onLinked: () => void   // called after link/unlink; parent invalidates query
}
```

### Section: Summary

```
Net activity        $1,410.22
Prior balance         +$23.78
Adjusted total      $1,434.00
Expected deposit    $1,234.56
Closing reserve      +$199.44
```

Closing reserve = `getAdjustedTotal(g) - getExpectedDeposit(g)`. Positive = carried forward. Hidden when no `expectedDeposit`.

### Section: Bank Match

**State: linked**
```
✓ Chase Checking · Jan 29, 2026 · $1,234.56
[Remove Match]
```
Remove Match → `unlinkCSVGroup` → invalidate queries → `onLinked()`.

**State: has expectedDeposit, not linked**
```
[Find Plaid Match]
```
On click → search:
```typescript
// Exact match first
const { data: exact } = await supabase
  .from('transactions')
  .select('*')
  .eq('source', 'plaid')
  .eq('amount', expectedDeposit)
  .gte('date', groupDateMin)
  .lte('date', addDays(groupDateMax, 14))
  .order('date')

// Near-match fallback (within ±$5.00) if exact is empty
const isNearMatch = exact.length === 0
```

Show candidate list inline. On candidate select:
1. If near-match: create manual transaction `{ amount: -(gap), schedule_c_category: 'commissions_fees', merchant: '{Platform} Disbursement Fee', source: 'manual', date: candidate.date }`
2. `markTransactionAsSettlement(candidate.id, platform)`
3. `linkCSVGroupToSettlement(group.groupId, candidate.id, platform)`
4. Invalidate `['csv-groups', platform]` and `['transactions']` → `onLinked()`

**State: on hold (no expectedDeposit)**
```
eBay held these funds in reserve — no bank deposit was made for this period.
The balance ($199.44) carries forward into the next payout. No action needed.
```

### Section: Transactions

List of `getNonTransferRows(group)` sorted by date:
```
Jan 15  Pokemon Booster Box     Revenue    +$89.99
Jan 16  eBay Final Value Fee    Fees        −$13.45
Jan 17  eBay Shipping Label     Shipping    −$8.99
```

Category display labels:
- `payout` → "Revenue"
- `commissions_fees` → "Fees"
- `shipping_postage` → "Shipping"
- `advertising` → "Advertising"
- `other_expense` → "Other"
- `balance_adjustment` → "Adjustment"
- `taxes_licenses` → "Tax Withheld"

### Section: Payout Row

Shown only if `getTransferRow(group)` exists:
```
Payout row (stored)   eBay Payout   Jan 28   −$1,234.56
```

---

## Files Changed

| File | Change |
|---|---|
| `supabase/functions/sync_csv_orders_to_sales/index.ts` | New edge function |
| `src/lib/types.ts` | Add CSVImportResult, CSVSaleSyncResult, CSVGroup; add missing Transaction fields |
| `src/lib/queries.ts` | Add buildCSVGroups, CSV helper functions, useCSVGroups |
| `src/lib/mutations.ts` | Add importMarketplaceCSV, syncCSVOrders, markTransactionAsSettlement, linkCSVGroupToSettlement, unlinkCSVGroup |
| `src/pages/SettingsPage.tsx` | Add CSV Import section + Settlement Status section |
| `src/components/CSVGroupDetailSlideOver.tsx` | New settlement group detail component |
| `docs/features/settings.md` | Document new sections |
| `TASKS.md` | Close CSV Import + Settlement Status + CSV→Sales items on ship |
