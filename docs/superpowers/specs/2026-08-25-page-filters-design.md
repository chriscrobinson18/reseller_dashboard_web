# Page Filters Design

_Date: 2026-08-25_

## Goal

Add meaningful client-side filters to Expenses, Sales, and Inventory. No new queries or schema changes — all data is already fetched.

---

## Expenses

**New filters** (added alongside the existing category dropdown + sale rows toggle):

| Filter | Options | Field |
|---|---|---|
| Direction | All / Income / Expense | `t.amount > 0` / `t.amount < 0` |
| Source | All / Bank / Manual | `t.source === 'plaid'` / `'manual'` |
| Account | All / [each account with transactions in period] | `t.plaid_account_id` |

**Account dropdown:**
- Options derived from fetched transactions: unique `plaid_account_id` + `account_display` pairs (no extra query — `fetchTransactions` selects `*`).
- Only accounts that have transactions in the current period appear.
- Manual / non-Plaid transactions (`plaid_account_id = null`) only appear under "All".

**State additions to `ExpensesPage`:**
```typescript
const [dirFilter, setDirFilter] = useState<'all' | 'income' | 'expense'>('all')
const [sourceFilter, setSourceFilter] = useState<'all' | 'plaid' | 'manual'>('all')
const [accountFilter, setAccountFilter] = useState<string | null>(null)
```

**Updated `filtered` useMemo:**
```typescript
const filtered = useMemo(() => {
  const terms = parseSearchTerms(search)
  return transactions.filter(t => {
    if (!showSaleLinked && (t.related_sale_id || t.source === 'csv_import')) return false
    if (catFilter && t.schedule_c_category !== catFilter) return false
    if (dirFilter === 'income' && t.amount <= 0) return false
    if (dirFilter === 'expense' && t.amount >= 0) return false
    if (sourceFilter === 'plaid' && t.source !== 'plaid') return false
    if (sourceFilter === 'manual' && t.source !== 'manual') return false
    if (accountFilter && t.plaid_account_id !== accountFilter) return false
    return matchesSearch(t, terms, customsAll)
  })
}, [transactions, showSaleLinked, catFilter, dirFilter, sourceFilter, accountFilter, search, customsAll])
```

**Account options derivation:**
```typescript
const accountOptions = useMemo(() => {
  const seen = new Map<string, string>()
  for (const t of transactions) {
    if (t.plaid_account_id && t.account_display && !seen.has(t.plaid_account_id)) {
      seen.set(t.plaid_account_id, t.account_display)
    }
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }))
}, [transactions])
```

**UI placement:** Three new `<select>` dropdowns in the existing filter bar row, after the category dropdown. Same style as the category dropdown (border, rounded-lg, text-sm, ChevronDown).

---

## Sales

**New filters** (added to the existing search bar row):

| Filter | Options | Field |
|---|---|---|
| Platform | All / [platforms in data] | `s.platform` |
| Returns | All / No returns / Has returns | `s.return_status` |

**Platform options** derived from fetched sales (unique non-null `platform` values, sorted).

**Return status values:** `null` (no return), `'partial'`, `'full'` — per `Sale` type.

**State additions to `SalesPage`:**
```typescript
const [platformFilter, setPlatformFilter] = useState<string | null>(null)
const [returnFilter, setReturnFilter] = useState<'all' | 'none' | 'has_return'>('all')
```

**Updated `filtered` useMemo:**
```typescript
const filtered = useMemo(() => {
  return sales.filter(s => {
    if (platformFilter && s.platform !== platformFilter) return false
    if (returnFilter === 'none' && s.return_status != null) return false
    if (returnFilter === 'has_return' && s.return_status == null) return false
    if (!search) return true
    const q = search.toLowerCase()
    return (
      (s.items?.name ?? '').toLowerCase().includes(q) ||
      (s.external_order_id ?? '').toLowerCase().includes(q) ||
      (s.platform ?? '').toLowerCase().includes(q) ||
      (s.payment_method ?? '').toLowerCase().includes(q) ||
      (paymentMethodLabel(s.payment_method) ?? '').toLowerCase().includes(q)
    )
  })
}, [sales, search, platformFilter, returnFilter])
```

**Platform options derivation:**
```typescript
const platformOptions = useMemo(() => {
  const seen = new Set<string>()
  for (const s of sales) { if (s.platform) seen.add(s.platform) }
  return [...seen].sort()
}, [sales])
```

**UI placement:** Platform and Returns dropdowns added to the right of the search input, to the left of the "Record Sale" button.

---

## Inventory

**New filter** (toggle added to existing search row):

| Filter | Type | Logic |
|---|---|---|
| In stock only | Toggle (boolean) | Include item only if `i.lots.some(l => l.quantity_remaining > 0)` |

**State addition to `InventoryPage`:**
```typescript
const [inStockOnly, setInStockOnly] = useState(false)
```

**Updated `filtered` useMemo:**
```typescript
const filtered = useMemo(() => {
  let result = items
  if (inStockOnly) result = result.filter(i => i.lots.some(l => l.quantity_remaining > 0))
  if (!search) return result
  const q = search.toLowerCase()
  return result.filter(i =>
    i.name.toLowerCase().includes(q) ||
    (i.category ?? '').toLowerCase().includes(q)
  )
}, [items, search, inStockOnly])
```

**UI placement:** Small toggle button ("In stock only") to the right of the search box, before the view switcher buttons. Active state uses a filled style (e.g., `bg-gray-900 text-white`), inactive is outlined.

---

## Shared UX Rules

- Filters are additive (AND logic).
- Filters do not reset on period change (sticky within the session).
- When a filter is active and reduces the list to zero rows, show the standard empty state (no special "no results" design needed).
- Dropdown options that have no matches in the current period still appear if they're static (Direction, Source, Returns). Dynamic options (Platform, Account) naturally shrink with the period.

---

## Files Changed

| File | Change |
|---|---|
| `src/pages/ExpensesPage.tsx` | Add dirFilter, sourceFilter, accountFilter state + dropdowns + updated useMemo |
| `src/pages/SalesPage.tsx` | Add platformFilter, returnFilter state + dropdowns + updated useMemo |
| `src/pages/InventoryPage.tsx` | Add inStockOnly state + toggle + updated useMemo |
