# Bundles Page — Design

_2026-09-28 · P2 feature · web-first_

---

## Overview

Bundle sales are currently only discoverable by finding a sale with a bundle badge on the Sales page. This feature adds a **dedicated Bundles page** in the nav showing every bundle sale as a table row — date, platform, order ID, item count, and net payout. Clicking a row opens the existing `BundleDetailSlideOver`.

---

## Data Model

No schema changes.

### New query: `useBundles()`

```typescript
// src/lib/queries.ts
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
          fees: row.fees as number | null,
          shipping_cost: row.shipping_cost as number | null,
          itemCount,
          netPayout,
        }
      })
    },
  })
}
```

---

## UI

### Nav + Route

Add after Sales in the NAV array:

```typescript
{ to: '/bundles', icon: ShoppingBag, label: 'Bundles' }
```

`ShoppingBag` is from `lucide-react` (not yet imported in Layout.tsx). Add route `/bundles` → `<BundlesPage />` in `App.tsx`.

### Table layout

```
┌──────────┬──────────┬──────────────┬───────┬────────────┐
│ Date     │ Platform │ Order ID     │ Items │ Net Payout │
├──────────┼──────────┼──────────────┼───────┼────────────┤
│ Sep 4    │ ebay     │ 12-345-678   │ 3     │ $47.20     │
│ Aug 28   │ —        │ —            │ 1     │ $12.00     │
└──────────┴──────────┴──────────────┴───────┴────────────┘
```

- Sticky `<thead>` (`sticky top-0 bg-gray-50 border-b border-gray-200 z-10`) consistent with other pages
- Platform displayed as plain text; `—` if null
- Clicking any row opens `BundleDetailSlideOver` with that bundle's `id`
- **Empty state:** "No bundle sales yet. Bundle a sale from the Sales page."
- **Page footer:** `N bundle` / `N bundles` count

### Cache invalidation

Any mutation that creates or deletes a bundle must invalidate `['bundles']`. The relevant sites:
- Bundle creation: wherever `sale_bundles` rows are inserted (check `src/lib/mutations.ts` and modals)
- Bundle deletion: `BundleDetailSlideOver.tsx` delete handler

---

## Files

| Action | File |
|---|---|
| Modify | `src/lib/queries.ts` — add `useBundles()` |
| Create | `src/pages/BundlesPage.tsx` |
| Modify | `src/components/Layout.tsx` — add `ShoppingBag` import + nav entry |
| Modify | `src/App.tsx` — add `/bundles` route |
| Modify | `src/lib/mutations.ts` and/or modals — add `['bundles']` invalidation to bundle create/delete |

---

## Edge Cases

- **Bundle with no lines (all deleted):** `itemCount = 0`, `netPayout = -(fees + shipping)`. Show `0 items` and the negative net payout.
- **Bundle with no fees/shipping:** `fees = null` treated as 0 in netPayout calculation.
- **No bundles:** Empty state with guidance to use Sales page.

---

## Out of Scope (v1)

- Filtering by platform or date range
- Sorting controls
- Inline edit from the list (use slide-over)
