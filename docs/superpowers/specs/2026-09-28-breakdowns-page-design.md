# Breakdowns Page — Design

_2026-09-28 · P2 feature · web-first_

---

## Overview

Box breakdowns are currently buried as a third toggle inside the Inventory page. This feature promotes breakdowns to a **dedicated top-level page** in the nav, showing every breakdown (open and closed) as a card — each card immediately revealing what the box was broken down into (child items and their allocated basis).

The Inventory page reverts to its original two-way toggle (By Item / By Date).

---

## Data Model

No schema changes. One new query replaces `useBoxOpenings` for the new page.

### New query: `useBoxOpeningsWithItems()`

Replaces `useBoxOpenings` (same query key `['box-openings']` so all existing mutation invalidations continue to work). `useBoxOpenings` is removed from `queries.ts`.

```typescript
// src/lib/queries.ts
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

Sort order: open breakdowns first (by `opened_at` desc), closed second (by `opened_at` desc) — derived in the component via `useMemo`.

---

## UI

### Nav + Route

Add a sixth nav item between Inventory and Expenses:

```typescript
{ to: '/breakdowns', icon: PackageOpen, label: 'Breakdowns' }
```

Add route `/breakdowns` → `<BreakdownsPage />` in `App.tsx`.

### Card layout

Each breakdown renders as a card (`rounded-lg border bg-white shadow-sm`):

**Card header** (always visible):
- Box name (bold, left)
- `opened_at` formatted as date (muted, right of name)
- Status badge: amber "In Progress" for `open`; gray "Closed" for `closed` (far right)
- `box_cost` formatted as USD below name, or `—` if null

**Card body** (child items, always expanded — no toggle):
- One row per non-deleted child lot: item name (left) + `unit_cost` formatted as USD (right, tabular-nums)
- If `pullCount === 0`: single muted row "No pulls yet"

**Card footer** (open breakdowns with `box_cost !== null` only):
- `Pool remaining: $X.XX of $Y.YY` — remaining shown in green if `< $0.01`, gray otherwise

Clicking anywhere on a card calls `setOpenBoxOpeningId(card.id)` to open the existing `BoxOpeningDetailSlideOver`.

**Empty state:** "No breakdowns yet — use 'Breakdown Inventory' on the Inventory page to open a box."

**Page footer:** `N breakdown` / `N breakdowns` count.

### Inventory page revert

Remove the `'breakdowns'` option from the `InventoryView` type, the toggle, the `useBoxOpenings` import/call, the `breakdownRows`/`breakdowns`/`isBreakdownsLoading` variables, and the breakdowns render block + footer branch.

---

## Files

| Action | File |
|---|---|
| Modify | `src/lib/queries.ts` — replace `useBoxOpenings` with `useBoxOpeningsWithItems()` (same key) |
| Create | `src/pages/BreakdownsPage.tsx` |
| Modify | `src/components/Layout.tsx` — add nav entry |
| Modify | `src/App.tsx` — add route |
| Modify | `src/pages/InventoryPage.tsx` — revert to two-way toggle |

---

## Edge Cases

- **Open breakdown, no pulls yet:** `pullCount = 0`, body shows "No pulls yet". If `box_cost` is set, footer shows "Pool remaining: $X.XX of $X.XX".
- **Open breakdown, `box_cost = null`:** `remainingBasis = null`. Footer not shown. Items listed normally.
- **Closed breakdown:** No footer. Items listed. Status badge gray "Closed".
- **No breakdowns:** Empty state with guidance to use Inventory page.

---

## Out of Scope (v1)

- Filtering/searching breakdowns by name or date range
- Sorting controls (default sort is sufficient)
- Inline editing from the list (use slide-over)
- Updating mutation invalidation call sites (they already use `['box-openings']` which matches the new query key)
