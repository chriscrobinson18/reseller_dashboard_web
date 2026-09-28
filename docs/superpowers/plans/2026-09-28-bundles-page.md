# Bundles Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `/bundles` top-level page showing all bundle sales as a table, replacing the current approach where bundles are only discoverable from the Sales page.

**Architecture:** Three file changes + one new file. Add `useBundles()` query hook (key `['bundles']`) and add `['bundles']` invalidation to the two mutation sites. New `BundlesPage.tsx` renders a sortable table. Layout + App wired for nav and routing.

**Tech Stack:** Vite + React 19 + TypeScript, TanStack React Query, Tailwind v4, Supabase JS, React Router v7, Lucide React.

---

## Files

| Action | File |
|---|---|
| Modify | `src/lib/queries.ts` — add `useBundles()` |
| Modify | `src/components/modals/RecordSaleModal.tsx` — add `['bundles']` invalidation |
| Modify | `src/components/BundleDetailSlideOver.tsx` — add `['bundles']` invalidation |
| Create | `src/pages/BundlesPage.tsx` |
| Modify | `src/components/Layout.tsx` — add `ShoppingBag` import + nav entry |
| Modify | `src/App.tsx` — add `/bundles` route |

---

### Task 1: Add `useBundles()` and wire cache invalidations

**Files:**
- Modify: `src/lib/queries.ts` (add after `useBundles` — or wherever the other `use*` plural hooks live)
- Modify: `src/components/modals/RecordSaleModal.tsx` (around line 97, in `onSuccess`)
- Modify: `src/components/BundleDetailSlideOver.tsx` (around line 28, in `onSuccess`)

- [ ] **Step 1: Add `useBundles()` to `src/lib/queries.ts`**

Open `src/lib/queries.ts`. Find a good location — add after `useBoxOpeningsWithItems` (around line 264). Insert:

```typescript
/** All bundle sales for the current user, newest-first, with derived item count and net payout. */
export function useBundles() {
  return useQuery({
    queryKey: ['bundles'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sale_bundles')
        .select('id, sold_at, platform, external_order_id, fees, shipping_cost, sales(id, sale_price, quantity, deleted_at)')
        .is('deleted_at', null)
        .order('sold_at', { ascending: false })
      if (error) throw error
      return (data ?? []).map(row => {
        const lines = ((row.sales ?? []) as { id: string; sale_price: number; quantity: number; deleted_at: string | null }[])
          .filter(s => !s.deleted_at)
        const itemCount = lines.length
        const itemsTotal = lines.reduce((s, l) => s + l.sale_price * l.quantity, 0)
        const netPayout = itemsTotal - (row.fees ?? 0) - (row.shipping_cost ?? 0)
        return {
          id: row.id as string,
          sold_at: row.sold_at as string,
          platform: row.platform as string | null,
          external_order_id: row.external_order_id as string | null,
          itemCount,
          netPayout,
        }
      })
    },
  })
}
```

- [ ] **Step 2: Add `['bundles']` invalidation to `RecordSaleModal.tsx`**

Open `src/components/modals/RecordSaleModal.tsx`. Find the `onSuccess` handler around line 95 that currently has:
```typescript
    onSuccess: ({ oversoldCount }) => {
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
```
Add one line after the existing invalidations:
```typescript
      qc.invalidateQueries({ queryKey: ['bundles'] })
```

- [ ] **Step 3: Add `['bundles']` invalidation to `BundleDetailSlideOver.tsx`**

Open `src/components/BundleDetailSlideOver.tsx`. Find the `del` mutation `onSuccess` around line 28 that currently ends with:
```typescript
      qc.invalidateQueries({ queryKey: ['bundle'] })
      setConfirmDelete(false)
      onClose()
```
Add one line before `setConfirmDelete`:
```typescript
      qc.invalidateQueries({ queryKey: ['bundles'] })
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
git add src/lib/queries.ts src/components/modals/RecordSaleModal.tsx src/components/BundleDetailSlideOver.tsx
git commit -m "feat: add useBundles query and wire cache invalidations"
```

---

### Task 2: Create `src/pages/BundlesPage.tsx`

**Files:**
- Create: `src/pages/BundlesPage.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useState } from 'react'
import { formatUSD, formatDate } from '../lib/utils'
import { useBundles } from '../lib/queries'
import BundleDetailSlideOver from '../components/BundleDetailSlideOver'

export default function BundlesPage() {
  const [openBundleId, setOpenBundleId] = useState<string | null>(null)
  const { data: bundles = [], isLoading } = useBundles()

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 bg-white">
        <h1 className="text-lg font-semibold text-gray-900">Bundles</h1>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : bundles.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            No bundle sales yet. Bundle a sale from the Sales page.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Date</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Platform</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Order ID</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Items</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Net Payout</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map(b => (
                <tr
                  key={b.id}
                  onClick={() => setOpenBundleId(b.id)}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2.5 text-gray-600 tabular-nums">{formatDate(b.sold_at)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{b.platform ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500 font-mono text-xs">{b.external_order_id ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right text-gray-500 tabular-nums">{b.itemCount}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium text-gray-900">
                    {formatUSD(b.netPayout)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
        {bundles.length} {bundles.length === 1 ? 'bundle' : 'bundles'}
      </div>

      <BundleDetailSlideOver bundleId={openBundleId} onClose={() => setOpenBundleId(null)} />
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors (or only "BreakdownsPage not found in routes" if Layout/App not wired yet — that's OK).

- [ ] **Step 3: Commit**

```bash
git add src/pages/BundlesPage.tsx
git commit -m "feat: add BundlesPage with table layout"
```

---

### Task 3: Add Bundles nav item and route

**Files:**
- Modify: `src/components/Layout.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `ShoppingBag` to Layout.tsx import and add nav entry**

In `src/components/Layout.tsx`, find:
```typescript
import { LayoutDashboard, ShoppingCart, Package, PackageOpen, Receipt, Settings, LogOut } from 'lucide-react'
```
Replace with:
```typescript
import { LayoutDashboard, ShoppingCart, ShoppingBag, Package, PackageOpen, Receipt, Settings, LogOut } from 'lucide-react'
```

Find the `NAV` array and add Bundles after Sales:
```typescript
const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sales', icon: ShoppingCart, label: 'Sales' },
  { to: '/bundles', icon: ShoppingBag, label: 'Bundles' },
  { to: '/inventory', icon: Package, label: 'Inventory' },
  { to: '/breakdowns', icon: PackageOpen, label: 'Breakdowns' },
  { to: '/expenses', icon: Receipt, label: 'Expenses' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]
```

- [ ] **Step 2: Add route and import in `src/App.tsx`**

Find:
```typescript
import BreakdownsPage from './pages/BreakdownsPage'
```
Replace with:
```typescript
import BreakdownsPage from './pages/BreakdownsPage'
import BundlesPage from './pages/BundlesPage'
```

Find:
```typescript
              <Route path="/inventory" element={<InventoryPage />} />
```
Replace with:
```typescript
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/bundles" element={<BundlesPage />} />
```

- [ ] **Step 3: Verify clean build**

```bash
npm run build 2>&1 | head -20
```

Expected: **zero TypeScript errors**.

- [ ] **Step 4: Run tests**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: 78 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/Layout.tsx src/App.tsx
git commit -m "feat: add Bundles nav item and route"
```

---

## Manual Verification Checklist

- [ ] Nav shows Bundles between Sales and Inventory
- [ ] `/bundles` loads the Bundles page
- [ ] All bundle sales appear as table rows (date, platform, order ID, items, net payout)
- [ ] Clicking a row opens `BundleDetailSlideOver`
- [ ] Empty state shows when no bundles exist
- [ ] Footer count correct ("N bundles")
- [ ] After recording a new bundle sale, Bundles page refreshes (cache invalidation works)
- [ ] After deleting a bundle from the slide-over, it disappears from the list
