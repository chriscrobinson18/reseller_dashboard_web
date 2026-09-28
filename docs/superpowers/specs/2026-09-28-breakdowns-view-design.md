# Breakdowns View — Design

_2026-09-28 · P2 feature · web-first_

---

## Overview

Box breakdowns are currently only discoverable by finding a child lot on the Inventory page and clicking its teal pill. There is no way to see all breakdowns at a glance. This feature adds a **Breakdowns tab** to the Inventory page — a third view alongside "By Item" and "By Date" — showing all breakdowns (open and closed) with their key details.

---

## Data Model

No schema changes. All data is already in `box_openings` and `inventory_lots`.

### New query: `useBoxOpenings()`

```typescript
// src/lib/queries.ts
export function useBoxOpenings() {
  return useQuery({
    queryKey: ['box-openings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('box_openings')
        .select('id, box_name, opened_at, box_cost, status, quantity, allocation_method, inventory_lots(unit_cost)')
        .is('deleted_at', null)
        .order('opened_at', { ascending: false })
      if (error) throw error
      return (data ?? []).map(row => {
        const lots = (row.inventory_lots ?? []) as { unit_cost: number }[]
        const pullCount = lots.length
        const allocated = lots.reduce((s, l) => s + l.unit_cost, 0)
        const remainingBasis = row.status === 'open'
          ? Math.max(0, Number(((row.box_cost ?? 0) - allocated).toFixed(2)))
          : null
        return { ...row, pullCount, remainingBasis }
      })
    },
  })
}
```

`remainingBasis` is only computed for open breakdowns (null for closed). `inventory_lots` embed is filtered to non-deleted rows automatically by RLS.

---

## UI

### View toggle

The existing two-way toggle ("By Item" / "By Date") becomes three-way:

```
[ By Item ]  [ By Date ]  [ Breakdowns ]
```

Same button group component and view state variable — just add a third option `'breakdowns'`.

### Breakdowns list

A flat table/list rendered when `view === 'breakdowns'`. Sorted: open breakdowns first (by `opened_at` desc), then closed (by `opened_at` desc).

**Columns per row:**

| Field | Notes |
|---|---|
| Box name | Bold |
| Date | `opened_at`, formatted |
| Status badge | Amber "In Progress" for `open`; gray "Closed" for `closed` |
| Pulls | e.g. "4 cards" (0 = "No pulls yet") |
| Cost | `box_cost` formatted as USD |
| Remaining | `formatUSD(remainingBasis)` for open breakdowns only; `—` for closed |

Clicking any row opens `BoxOpeningDetailSlideOver` with that breakdown's `id`.

**Empty state:** "No breakdowns yet — use 'Breakdown Inventory' to open a box."

### "Breakdown Inventory" button

Already present in the InventoryPage header. No change needed — it remains visible regardless of active view.

---

## Files

| Action | File |
|---|---|
| Modify | `src/lib/queries.ts` — add `useBoxOpenings()` |
| Modify | `src/pages/InventoryPage.tsx` — add third view toggle option + Breakdowns list |

No new files required.

---

## Edge Cases

- **Box with no child lots (just started):** `pullCount = 0`, `remainingBasis = box_cost`. Shows "No pulls yet", full remaining.
- **Box with `box_cost = null`:** `remainingBasis = null` (treated as open with no cost info). Show `—` in Remaining column.
- **Deleted child lots:** RLS and `is('deleted_at', null)` on lot queries exclude them automatically; the embed doesn't filter deleted lots unless we add `.is('deleted_at', null)` on the nested select. Add `inventory_lots!inner(unit_cost).is(deleted_at, null)` or compute remaining in a separate step if the embed doesn't support the filter. Fall back to fetching child counts separately if needed.

---

## Out of Scope (v1)

- Filtering/searching breakdowns by name or date range
- Sorting controls (default sort is sufficient)
- Inline edit of breakdown from the list (use slide-over)
