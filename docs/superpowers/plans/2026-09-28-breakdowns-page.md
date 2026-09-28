# Breakdowns Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move box breakdowns from a toggle inside Inventory to a dedicated top-level "Breakdowns" page showing each breakdown as a card with its child items always visible.

**Architecture:** Four file changes + one new file. Replace `useBoxOpenings` with a richer `useBoxOpeningsWithItems` query (same cache key so all existing invalidations work). New `BreakdownsPage.tsx` renders sorted breakdown cards. Inventory page reverts to its original two-way toggle.

**Tech Stack:** Vite + React 19 + TypeScript, TanStack React Query, Tailwind v4, Supabase JS, React Router v7, Lucide React icons.

---

## Files

| Action | File |
|---|---|
| Modify | `src/lib/queries.ts` — replace `useBoxOpenings` with `useBoxOpeningsWithItems` |
| Create | `src/pages/BreakdownsPage.tsx` |
| Modify | `src/components/Layout.tsx` — add Breakdowns nav item |
| Modify | `src/App.tsx` — add `/breakdowns` route |
| Modify | `src/pages/InventoryPage.tsx` — revert to two-way toggle |

---

### Task 1: Replace `useBoxOpenings` with `useBoxOpeningsWithItems` in `src/lib/queries.ts`

**Files:**
- Modify: `src/lib/queries.ts` (around line 228 — the `useBoxOpenings` function)

The new query selects child lots with their linked items so the Breakdowns page can show item names inline. It keeps the same query key `['box-openings']` so all existing `invalidateQueries({ queryKey: ['box-openings'] })` calls in mutations/modals continue to work without any changes.

- [ ] **Step 1: Open `src/lib/queries.ts` and find the `useBoxOpenings` function**

It starts around line 228 with:
```typescript
/** All box breakdowns for the current user, newest-first, with derived pull count and remaining basis. */
export function useBoxOpenings() {
```

- [ ] **Step 2: Replace the entire `useBoxOpenings` function with `useBoxOpeningsWithItems`**

Replace from the JSDoc comment through the closing `}` with:

```typescript
/** All box breakdowns for the current user, newest-first, with child lots and item names. */
export function useBoxOpeningsWithItems() {
  return useQuery({
    queryKey: ['box-openings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('box_openings')
        .select('id, box_name, opened_at, box_cost, status, inventory_lots(id, unit_cost, deleted_at, items(id, name))')
        .is('deleted_at', null)
        .order('opened_at', { ascending: false })
      if (error) throw error
      return (data ?? []).map(row => {
        const lots = ((row.inventory_lots ?? []) as {
          id: string
          unit_cost: number
          deleted_at: string | null
          items: { id: string; name: string } | null
        }[]).filter(l => !l.deleted_at)
        const pullCount = lots.length
        const allocated = lots.reduce((s, l) => s + l.unit_cost, 0)
        const remainingBasis = row.status === 'open' && row.box_cost !== null
          ? Math.max(0, Number(((row.box_cost) - allocated).toFixed(2)))
          : null
        return {
          id: row.id as string,
          box_name: row.box_name as string,
          opened_at: row.opened_at as string,
          box_cost: row.box_cost as number | null,
          status: row.status as 'open' | 'closed',
          lots,
          pullCount,
          remainingBasis,
        }
      })
    },
  })
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -30
```

Expected: TypeScript errors about `useBoxOpenings` not found in InventoryPage.tsx (that's expected — will be fixed in Task 4). No other errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/queries.ts
git commit -m "feat: replace useBoxOpenings with useBoxOpeningsWithItems (items join)"
```

---

### Task 2: Create `src/pages/BreakdownsPage.tsx`

**Files:**
- Create: `src/pages/BreakdownsPage.tsx`

- [ ] **Step 1: Create the file with the full implementation**

```tsx
import { useState, useMemo } from 'react'
import { formatUSD, formatDate } from '../lib/utils'
import { useBoxOpeningsWithItems } from '../lib/queries'
import BoxOpeningDetailSlideOver from '../components/BoxOpeningDetailSlideOver'

export default function BreakdownsPage() {
  const [openBoxOpeningId, setOpenBoxOpeningId] = useState<string | null>(null)
  const { data: rows = [], isLoading } = useBoxOpeningsWithItems()

  const breakdowns = useMemo(() => {
    const open = rows.filter(b => b.status === 'open').sort((a, b) => b.opened_at.localeCompare(a.opened_at))
    const closed = rows.filter(b => b.status === 'closed').sort((a, b) => b.opened_at.localeCompare(a.opened_at))
    return [...open, ...closed]
  }, [rows])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 bg-white">
        <h1 className="text-lg font-semibold text-gray-900">Breakdowns</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : breakdowns.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            No breakdowns yet — use "Breakdown Inventory" on the Inventory page to open a box.
          </div>
        ) : (
          breakdowns.map(b => (
            <div
              key={b.id}
              onClick={() => setOpenBoxOpeningId(b.id)}
              className="rounded-lg border border-gray-200 bg-white shadow-sm cursor-pointer hover:border-gray-300 hover:shadow transition-all"
            >
              {/* Card header */}
              <div className="px-4 py-3 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{b.box_name}</span>
                    <span className="text-xs text-gray-400">{formatDate(b.opened_at)}</span>
                  </div>
                  <div className="text-sm text-gray-500 mt-0.5">
                    {b.box_cost !== null ? formatUSD(b.box_cost) : '—'}
                  </div>
                </div>
                {b.status === 'open' ? (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">In Progress</span>
                ) : (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">Closed</span>
                )}
              </div>

              {/* Divider */}
              <div className="border-t border-gray-100" />

              {/* Card body — items */}
              <div className="px-4 py-2">
                {b.pullCount === 0 ? (
                  <div className="py-1 text-sm text-gray-400 italic">No pulls yet</div>
                ) : (
                  b.lots.map(lot => (
                    <div key={lot.id} className="flex items-center justify-between py-1">
                      <span className="text-sm text-gray-700">{lot.items?.name ?? '—'}</span>
                      <span className="text-sm tabular-nums text-gray-600">{formatUSD(lot.unit_cost)}</span>
                    </div>
                  ))
                )}
              </div>

              {/* Card footer — pool remaining (open breakdowns with known box_cost only) */}
              {b.status === 'open' && b.remainingBasis !== null && (
                <>
                  <div className="border-t border-gray-100" />
                  <div className="px-4 py-2 flex items-center justify-between">
                    <span className="text-xs text-gray-500">Pool remaining</span>
                    <span className={`text-sm tabular-nums font-medium ${b.remainingBasis < 0.01 ? 'text-green-600' : 'text-gray-700'}`}>
                      {formatUSD(b.remainingBasis)} of {formatUSD(b.box_cost!)}
                    </span>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
        {breakdowns.length} {breakdowns.length === 1 ? 'breakdown' : 'breakdowns'}
      </div>

      <BoxOpeningDetailSlideOver
        boxOpeningId={openBoxOpeningId}
        onClose={() => setOpenBoxOpeningId(null)}
      />
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles (this file alone)**

```bash
npm run build 2>&1 | head -30
```

Expected: same InventoryPage errors as before (unfixed yet), no new errors from BreakdownsPage.tsx.

- [ ] **Step 3: Commit**

```bash
git add src/pages/BreakdownsPage.tsx
git commit -m "feat: add BreakdownsPage with card layout"
```

---

### Task 3: Add Breakdowns nav item and route

**Files:**
- Modify: `src/components/Layout.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `PackageOpen` to the Layout.tsx import and add the nav entry**

In `src/components/Layout.tsx`, find:
```typescript
import { LayoutDashboard, ShoppingCart, Package, Receipt, Settings, LogOut } from 'lucide-react'
```
Replace with:
```typescript
import { LayoutDashboard, ShoppingCart, Package, PackageOpen, Receipt, Settings, LogOut } from 'lucide-react'
```

Find the `NAV` array:
```typescript
const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sales', icon: ShoppingCart, label: 'Sales' },
  { to: '/inventory', icon: Package, label: 'Inventory' },
  { to: '/expenses', icon: Receipt, label: 'Expenses' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]
```
Replace with:
```typescript
const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sales', icon: ShoppingCart, label: 'Sales' },
  { to: '/inventory', icon: Package, label: 'Inventory' },
  { to: '/breakdowns', icon: PackageOpen, label: 'Breakdowns' },
  { to: '/expenses', icon: Receipt, label: 'Expenses' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]
```

- [ ] **Step 2: Add the route and import in `src/App.tsx`**

Find:
```typescript
import InventoryPage from './pages/InventoryPage'
```
Replace with:
```typescript
import InventoryPage from './pages/InventoryPage'
import BreakdownsPage from './pages/BreakdownsPage'
```

Find:
```typescript
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/expenses" element={<ExpensesPage />} />
```
Replace with:
```typescript
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/breakdowns" element={<BreakdownsPage />} />
              <Route path="/expenses" element={<ExpensesPage />} />
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -30
```

Expected: still only the InventoryPage `useBoxOpenings` errors (not yet fixed). No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/Layout.tsx src/App.tsx
git commit -m "feat: add Breakdowns nav item and route"
```

---

### Task 4: Revert `src/pages/InventoryPage.tsx` to two-way toggle

**Files:**
- Modify: `src/pages/InventoryPage.tsx`

Four targeted removals — the `'breakdowns'` view type, the import, the hook calls, the render block, and the footer branch.

- [ ] **Step 1: Update the `InventoryView` type and remove the `useBoxOpenings` import**

Find:
```typescript
import { useItems, useIncompleteBreakdowns, useBoxOpenings, type ItemWithLots } from '../lib/queries'
```
Replace with:
```typescript
import { useItems, useIncompleteBreakdowns, type ItemWithLots } from '../lib/queries'
```

Find:
```typescript
type InventoryView = 'item' | 'date' | 'breakdowns'
```
Replace with:
```typescript
type InventoryView = 'item' | 'date'
```

- [ ] **Step 2: Remove the `useBoxOpenings` hook call and derived variables**

Find (the three lines after `useIncompleteBreakdowns`):
```typescript
  const { data: breakdownRows = [], isLoading: isBreakdownsLoading } = useBoxOpenings()
  const breakdowns = useMemo(() => {
    const open = breakdownRows.filter(b => b.status === 'open').sort((a, b) => b.opened_at.localeCompare(a.opened_at))
    const closed = breakdownRows.filter(b => b.status === 'closed').sort((a, b) => b.opened_at.localeCompare(a.opened_at))
    return [...open, ...closed]
  }, [breakdownRows])
```
Delete those lines entirely (replace with empty string).

- [ ] **Step 3: Revert the view toggle to two options**

Find:
```typescript
              {([['item', 'By Item'], ['date', 'By Date'], ['breakdowns', 'Breakdowns']] as const).map(([v, label]) => (
```
Replace with:
```typescript
              {([['item', 'By Item'], ['date', 'By Date']] as const).map(([v, label]) => (
```

- [ ] **Step 4: Remove the `view === 'breakdowns' ? null` short-circuit from the loading ternary**

Find:
```typescript
        ) : view === 'breakdowns' ? null : filtered.length === 0 ? (
```
Replace with:
```typescript
        ) : filtered.length === 0 ? (
```

- [ ] **Step 5: Remove the breakdowns render block**

Find and delete this entire block (including the surrounding blank lines):
```typescript
        {!isLoading && !isBreakdownsLoading && view === 'breakdowns' && (
          <div className="overflow-x-auto">
            {breakdowns.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                No breakdowns yet — use "Breakdown Inventory" to open a box.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Box</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Date</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Status</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Pulls</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Cost</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdowns.map(b => (
                    <tr
                      key={b.id}
                      onClick={() => setOpenBoxOpeningId(b.id)}
                      className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-2.5 font-medium text-gray-900">{b.box_name}</td>
                      <td className="px-4 py-2.5 text-gray-500 tabular-nums">{formatDate(b.opened_at)}</td>
                      <td className="px-4 py-2.5">
                        {b.status === 'open' ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">In Progress</span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">Closed</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-500 tabular-nums">
                        {b.pullCount === 0 ? <span className="text-gray-300">—</span> : `${b.pullCount} card${b.pullCount === 1 ? '' : 's'}`}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-700 tabular-nums">
                        {b.box_cost !== null ? formatUSD(b.box_cost) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {b.remainingBasis !== null
                          ? <span className={b.remainingBasis < 0.01 ? 'text-green-600' : 'text-gray-700'}>{formatUSD(b.remainingBasis)}</span>
                          : <span className="text-gray-300">—</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
```

- [ ] **Step 6: Revert the footer count**

Find:
```typescript
        {view === 'date'
          ? `${ledgerRows.length} ${ledgerRows.length === 1 ? 'lot' : 'lots'}`
          : view === 'breakdowns'
          ? `${breakdowns.length} ${breakdowns.length === 1 ? 'breakdown' : 'breakdowns'}`
          : `${filtered.length} items`}
```
Replace with:
```typescript
        {view === 'date'
          ? `${ledgerRows.length} ${ledgerRows.length === 1 ? 'lot' : 'lots'}`
          : `${filtered.length} items`}
```

- [ ] **Step 7: Verify TypeScript compiles clean**

```bash
npm run build 2>&1 | head -20
```

Expected: **no errors**.

- [ ] **Step 8: Run tests**

```bash
npx vitest run
```

Expected: 78 tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/pages/InventoryPage.tsx
git commit -m "feat: revert Inventory to two-way toggle, Breakdowns moved to own page"
```

---

## Manual Verification Checklist

After all tasks complete, verify in `npm run dev`:

- [ ] Nav shows: Dashboard | Sales | Inventory | Breakdowns | Expenses | Settings
- [ ] `/breakdowns` route loads the Breakdowns page
- [ ] Each breakdown shows as a card with box name, date, status badge, cost
- [ ] Child items (item name + basis) always visible inside each card — no expand needed
- [ ] Open breakdowns with box_cost show "Pool remaining: $X.XX of $Y.YY" footer
- [ ] Clicking any card opens BoxOpeningDetailSlideOver
- [ ] Empty state shows when no breakdowns exist
- [ ] Footer shows correct count ("N breakdowns")
- [ ] Inventory page shows two-way toggle only: By Item | By Date
- [ ] "By Item" and "By Date" views on Inventory still work correctly
