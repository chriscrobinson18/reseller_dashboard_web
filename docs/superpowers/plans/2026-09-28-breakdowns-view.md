# Breakdowns View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Breakdowns" third-view tab to the Inventory page showing all box breakdowns (open + closed) with status, pull count, cost, and remaining basis.

**Architecture:** Two file changes only. A new `useBoxOpenings()` hook in `queries.ts` fetches all breakdowns with embedded child lot costs (filtered client-side for soft-deletes). `InventoryPage.tsx` gets a third view option in the toggle and renders the breakdown list when selected.

**Tech Stack:** Vite + React 19 + TypeScript, TanStack React Query, Supabase JS client, Tailwind v4.

---

## Files

| Action | File |
|---|---|
| Modify | `src/lib/queries.ts` — add `useBoxOpenings()` |
| Modify | `src/pages/InventoryPage.tsx` — add `'breakdowns'` view option + list UI |

---

### Task 1: Add `useBoxOpenings()` to `src/lib/queries.ts`

**Files:**
- Modify: `src/lib/queries.ts` (add after the `useBoxOpening` hook, around line 226)

- [ ] **Step 1: Add the `useBoxOpenings` hook**

Open `src/lib/queries.ts`. After the closing brace of `useBoxOpening` (the hook ending around line 226), add:

```typescript
/** All box breakdowns for the current user, newest-first, with derived pull count and remaining basis. */
export function useBoxOpenings() {
  return useQuery({
    queryKey: ['box-openings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('box_openings')
        .select('id, box_name, opened_at, box_cost, status, quantity, allocation_method, inventory_lots(unit_cost, deleted_at)')
        .is('deleted_at', null)
        .order('opened_at', { ascending: false })
      if (error) throw error
      return (data ?? []).map(row => {
        const lots = ((row.inventory_lots ?? []) as { unit_cost: number; deleted_at: string | null }[]).filter(l => !l.deleted_at)
        const pullCount = lots.length
        const allocated = lots.reduce((s, l) => s + l.unit_cost, 0)
        const remainingBasis = row.status === 'open'
          ? Math.max(0, Number(((row.box_cost ?? 0) - allocated).toFixed(2)))
          : null
        return {
          id: row.id as string,
          box_name: row.box_name as string,
          opened_at: row.opened_at as string,
          box_cost: row.box_cost as number | null,
          status: row.status as 'open' | 'closed',
          pullCount,
          remainingBasis,
        }
      })
    },
  })
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/queries.ts
git commit -m "feat: add useBoxOpenings query"
```

---

### Task 2: Add Breakdowns view to `src/pages/InventoryPage.tsx`

**Files:**
- Modify: `src/pages/InventoryPage.tsx`

Four targeted changes: update the `InventoryView` type, import `useBoxOpenings`, add the toggle option, render the list.

- [ ] **Step 1: Update the `InventoryView` type and add `useBoxOpenings` import**

Find line:
```typescript
type InventoryView = 'item' | 'date'
```
Replace with:
```typescript
type InventoryView = 'item' | 'date' | 'breakdowns'
```

Find the existing import line:
```typescript
import { useItems, useIncompleteBreakdowns, type ItemWithLots } from '../lib/queries'
```
Replace with:
```typescript
import { useItems, useIncompleteBreakdowns, useBoxOpenings, type ItemWithLots } from '../lib/queries'
```

- [ ] **Step 2: Call `useBoxOpenings()` in the component and derive sorted list**

Find the existing hook calls near the top of the component body (after `const [view, setView] = useState<InventoryView>('item')`). Add:

```typescript
const { data: breakdownRows = [] } = useBoxOpenings()
const breakdowns = useMemo(() => {
  const open = breakdownRows.filter(b => b.status === 'open').sort((a, b) => b.opened_at.localeCompare(a.opened_at))
  const closed = breakdownRows.filter(b => b.status === 'closed').sort((a, b) => b.opened_at.localeCompare(a.opened_at))
  return [...open, ...closed]
}, [breakdownRows])
```

- [ ] **Step 3: Update the view toggle to include "Breakdowns"**

Find:
```typescript
{([['item', 'By Item'], ['date', 'By Date']] as const).map(([v, label]) => (
```
Replace with:
```typescript
{([['item', 'By Item'], ['date', 'By Date'], ['breakdowns', 'Breakdowns']] as const).map(([v, label]) => (
```

- [ ] **Step 4: Render the Breakdowns list**

Find the section that renders the `By Date` view (it's an `{view === 'date' && (...)}` block or similar). After that block and before the footer `<div className="px-4 py-2 border-t ...">`, add:

```tsx
{view === 'breakdowns' && (
  <div className="overflow-x-auto">
    {breakdowns.length === 0 ? (
      <div className="px-4 py-12 text-center text-sm text-gray-400">
        No breakdowns yet — use "Breakdown Inventory" to open a box.
      </div>
    ) : (
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide">
            <th className="px-4 py-2 text-left">Box</th>
            <th className="px-4 py-2 text-left">Date</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-right">Pulls</th>
            <th className="px-4 py-2 text-right">Cost</th>
            <th className="px-4 py-2 text-right">Remaining</th>
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

- [ ] **Step 5: Update the footer count line**

Find:
```typescript
{view === 'date'
  ? `${ledgerRows.length} ${ledgerRows.length === 1 ? 'lot' : 'lots'}`
  : `${filtered.length} items`}
```
Replace with:
```typescript
{view === 'date'
  ? `${ledgerRows.length} ${ledgerRows.length === 1 ? 'lot' : 'lots'}`
  : view === 'breakdowns'
  ? `${breakdowns.length} ${breakdowns.length === 1 ? 'breakdown' : 'breakdowns'}`
  : `${filtered.length} items`}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors. If `useMemo` is not imported, add it to the React import at the top (it's already imported per the file header — `import { useState, useMemo, Fragment } from 'react'`).

- [ ] **Step 7: Run tests**

```bash
npx vitest run
```

Expected: all 78 tests pass (no tests touch InventoryPage directly).

- [ ] **Step 8: Commit**

```bash
git add src/pages/InventoryPage.tsx
git commit -m "feat: add Breakdowns tab to Inventory page"
```

---

## Manual Verification Checklist

After both tasks are complete, verify in the dev server (`npm run dev`):

- [ ] Inventory page shows three-way toggle: "By Item | By Date | Breakdowns"
- [ ] Breakdowns tab shows all existing breakdowns (open and closed)
- [ ] Open breakdowns appear first with amber "In Progress" badge and remaining basis
- [ ] Closed breakdowns show gray "Closed" badge and `—` in Remaining column
- [ ] Clicking any row opens `BoxOpeningDetailSlideOver`
- [ ] Empty state shows when no breakdowns exist
- [ ] Footer count updates correctly for each view
- [ ] "By Item" and "By Date" views still work unchanged
