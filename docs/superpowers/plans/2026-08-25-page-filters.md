# Page Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add client-side filters to Expenses (direction/source/account), Sales (platform/return status), and Inventory (in-stock toggle).

**Architecture:** All filters are client-side useMemo transforms on already-fetched data — no new queries, no schema changes. Each page gets new state vars, an updated `filtered` useMemo, and new `<select>` or toggle elements in the existing filter bar.

**Tech Stack:** React 19, TypeScript, TanStack Query, Tailwind v4

---

## File Map

| File | Change |
|---|---|
| `src/pages/ExpensesPage.tsx` | Add dirFilter, sourceFilter, accountFilter state + accountOptions useMemo + updated filtered useMemo + filterSig + 3 select dropdowns |
| `src/pages/SalesPage.tsx` | Add platformFilter, returnFilter state + platformOptions useMemo + updated filtered useMemo + 2 select dropdowns |
| `src/pages/InventoryPage.tsx` | Add inStockOnly state + updated filtered useMemo + toggle button |

---

## Task 1: Expenses — Direction, Source, Account filters

**Files:**
- Modify: `src/pages/ExpensesPage.tsx`

- [ ] **Step 1: Add new state variables**

Find this block of state declarations near the top of `ExpensesPage` (starts with `const [period, setPeriod]`):

```typescript
const [catFilter, setCatFilter] = useState<string | null>(null)
const [showSaleLinked, setShowSaleLinked] = useState(false)
```

Add three new state vars immediately after `showSaleLinked`:

```typescript
const [catFilter, setCatFilter] = useState<string | null>(null)
const [showSaleLinked, setShowSaleLinked] = useState(false)
const [dirFilter, setDirFilter] = useState<'all' | 'income' | 'expense'>('all')
const [sourceFilter, setSourceFilter] = useState<'all' | 'plaid' | 'manual'>('all')
const [accountFilter, setAccountFilter] = useState<string | null>(null)
```

- [ ] **Step 2: Add accountOptions useMemo**

Find the existing `filtered` useMemo. Add `accountOptions` immediately BEFORE it:

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

- [ ] **Step 3: Update filtered useMemo**

Replace the existing `filtered` useMemo:

```typescript
// BEFORE:
const filtered = useMemo(() => {
  const terms = parseSearchTerms(search)
  return transactions.filter(t => {
    if (!showSaleLinked && (t.related_sale_id || t.source === 'csv_import')) return false
    if (catFilter && t.schedule_c_category !== catFilter) return false
    return matchesSearch(t, terms, customsAll)
  })
}, [transactions, showSaleLinked, catFilter, search, customsAll])
```

```typescript
// AFTER:
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

- [ ] **Step 4: Update filterSig to clear selection when new filters change**

Find this line:

```typescript
const filterSig = `${range.start}|${range.end}|${search}|${catFilter}|${showSaleLinked}`
```

Replace with:

```typescript
const filterSig = `${range.start}|${range.end}|${search}|${catFilter}|${showSaleLinked}|${dirFilter}|${sourceFilter}|${accountFilter}`
```

- [ ] **Step 5: Add three select dropdowns to the filter bar**

Find the existing filter bar row — it ends with the Sale rows toggle button and Add button:

```tsx
            <button
              onClick={() => setShowSaleLinked(!showSaleLinked)}
              className={`flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                showSaleLinked ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-400'
              }`}
            >
              <Filter size={12} /> Sale rows
            </button>
            <button
              onClick={() => setShowAddTx(true)}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-gray-700 transition-colors whitespace-nowrap"
            >
              <Plus size={13} /> Add
            </button>
```

Replace with (adds three selects before the Sale rows toggle):

```tsx
            <select
              value={dirFilter}
              onChange={e => setDirFilter(e.target.value as 'all' | 'income' | 'expense')}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              <option value="all">All directions</option>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
            <select
              value={sourceFilter}
              onChange={e => setSourceFilter(e.target.value as 'all' | 'plaid' | 'manual')}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              <option value="all">All sources</option>
              <option value="plaid">Bank (Plaid)</option>
              <option value="manual">Manual</option>
            </select>
            <select
              value={accountFilter ?? ''}
              onChange={e => setAccountFilter(e.target.value || null)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              <option value="">All accounts</option>
              {accountOptions.map(({ id, label }) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
            <button
              onClick={() => setShowSaleLinked(!showSaleLinked)}
              className={`flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                showSaleLinked ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-400'
              }`}
            >
              <Filter size={12} /> Sale rows
            </button>
            <button
              onClick={() => setShowAddTx(true)}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-gray-700 transition-colors whitespace-nowrap"
            >
              <Plus size={13} /> Add
            </button>
```

- [ ] **Step 6: Verify build**

```bash
cd /Users/user/Developer/reseller_dashboard_web
npm run build
```

Expected: no TypeScript errors (chunk-size warning is fine).

- [ ] **Step 7: Commit**

```bash
git add src/pages/ExpensesPage.tsx
git commit -m "feat(expenses): add direction, source, and account filters"
```

---

## Task 2: Sales — Platform and Return Status filters

**Files:**
- Modify: `src/pages/SalesPage.tsx`

- [ ] **Step 1: Add new state variables**

Find this block near the top of `SalesPage`:

```typescript
const [period, setPeriod] = useState<PeriodPreset>('ytd')
const [search, setSearch] = useState('')
const [selected, setSelected] = useState<Sale | null>(null)
```

Add two new state vars after `search`:

```typescript
const [period, setPeriod] = useState<PeriodPreset>('ytd')
const [search, setSearch] = useState('')
const [platformFilter, setPlatformFilter] = useState<string | null>(null)
const [returnFilter, setReturnFilter] = useState<'all' | 'none' | 'has_return'>('all')
const [selected, setSelected] = useState<Sale | null>(null)
```

- [ ] **Step 2: Add platformOptions useMemo**

Find the existing `filtered` useMemo. Add `platformOptions` immediately BEFORE it:

```typescript
const platformOptions = useMemo(() => {
  const seen = new Set<string>()
  for (const s of sales) { if (s.platform) seen.add(s.platform) }
  return [...seen].sort()
}, [sales])
```

- [ ] **Step 3: Update filtered useMemo**

Replace the existing `filtered` useMemo:

```typescript
// BEFORE:
const filtered = useMemo(() => {
  if (!search) return sales
  const q = search.toLowerCase()
  return sales.filter(s =>
    (s.items?.name ?? '').toLowerCase().includes(q) ||
    (s.external_order_id ?? '').toLowerCase().includes(q) ||
    (s.platform ?? '').toLowerCase().includes(q) ||
    (s.payment_method ?? '').toLowerCase().includes(q) ||
    (paymentMethodLabel(s.payment_method) ?? '').toLowerCase().includes(q)
  )
}, [sales, search])
```

```typescript
// AFTER:
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

- [ ] **Step 4: Add two select dropdowns to the filter bar**

Find the filter bar row in SalesPage JSX. It currently looks like:

```tsx
          <div className="flex items-center justify-between">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search item, order ID, platform, payment…"
              className="w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <button
              onClick={() => setShowRecordSale(true)}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
            >
              <Plus size={14} /> Record Sale
            </button>
          </div>
```

Replace with (adds the two selects between search and Record Sale button):

```tsx
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search item, order ID, platform, payment…"
              className="w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <select
              value={platformFilter ?? ''}
              onChange={e => setPlatformFilter(e.target.value || null)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              <option value="">All platforms</option>
              {platformOptions.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <select
              value={returnFilter}
              onChange={e => setReturnFilter(e.target.value as 'all' | 'none' | 'has_return')}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              <option value="all">All returns</option>
              <option value="none">No returns</option>
              <option value="has_return">Has return</option>
            </select>
            <div className="flex-1" />
            <button
              onClick={() => setShowRecordSale(true)}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
            >
              <Plus size={14} /> Record Sale
            </button>
          </div>
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/user/Developer/reseller_dashboard_web
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/SalesPage.tsx
git commit -m "feat(sales): add platform and return status filters"
```

---

## Task 3: Inventory — In-stock only toggle

**Files:**
- Modify: `src/pages/InventoryPage.tsx`

- [ ] **Step 1: Add inStockOnly state variable**

Find this line near the top of `InventoryPage`:

```typescript
const [search, setSearch] = useState('')
const [view, setView] = useState<InventoryView>('item')
```

Add the new state var after `search`:

```typescript
const [search, setSearch] = useState('')
const [inStockOnly, setInStockOnly] = useState(false)
const [view, setView] = useState<InventoryView>('item')
```

- [ ] **Step 2: Update filtered useMemo**

Find the existing `filtered` useMemo:

```typescript
const filtered = useMemo(() => {
  if (!search) return items
  const q = search.toLowerCase()
  return items.filter(i =>
    i.name.toLowerCase().includes(q) ||
    (i.category ?? '').toLowerCase().includes(q)
  )
}, [items, search])
```

Replace with:

```typescript
const filtered = useMemo(() => {
  let result = items
  if (inStockOnly) result = result.filter(i =>
    (i.inventory_lots ?? []).some(l => l.quantity_remaining > 0)
  )
  if (!search) return result
  const q = search.toLowerCase()
  return result.filter(i =>
    i.name.toLowerCase().includes(q) ||
    (i.category ?? '').toLowerCase().includes(q)
  )
}, [items, search, inStockOnly])
```

- [ ] **Step 3: Add toggle button to the filter bar**

Find the filter bar in InventoryPage JSX. It currently has the search input followed by the By Item / By Date view switcher:

```tsx
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search items…"
              className="w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
```

Add the toggle button between the search input and the view switcher:

```tsx
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search items…"
              className="w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <button
              type="button"
              onClick={() => setInStockOnly(v => !v)}
              className={`border rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                inStockOnly
                  ? 'bg-gray-900 border-gray-900 text-white'
                  : 'border-gray-200 text-gray-600 hover:border-gray-400'
              }`}
            >
              In stock only
            </button>
            <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/user/Developer/reseller_dashboard_web
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/InventoryPage.tsx
git commit -m "feat(inventory): add in-stock only filter toggle"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Expenses: Direction filter (amount > 0 / < 0) | Task 1 |
| Expenses: Source filter (plaid / manual) | Task 1 |
| Expenses: Account filter (plaid_account_id) | Task 1 |
| Expenses: Account options derived from transactions | Task 1 |
| Sales: Platform filter (derived from data) | Task 2 |
| Sales: Return status filter (none / has_return) | Task 2 |
| Inventory: In-stock only toggle | Task 3 |
| All filters: client-side, AND logic, no new queries | All tasks |

All requirements covered. No placeholders. Types used consistently across all tasks.
