# Trades Page — Design

_2026-09-28 · P2 feature · web-first_

---

## Overview

Trades are currently only discoverable via lot pills on the Inventory page. This feature adds a **dedicated Trades page** in the nav showing every trade as a table row — date, counterparty, gave FMV, received FMV, and cash boot. Clicking a row opens the existing `TradeDetailSlideOver`.

---

## Data Model

No schema changes.

### New query: `useTrades()`

```typescript
// src/lib/queries.ts
export function useTrades() {
  return useQuery({
    queryKey: ['trades'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trades')
        .select('id, traded_at, counterparty, given_fmv, received_fmv, cash_boot')
        .is('deleted_at', null)
        .order('traded_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as {
        id: string
        traded_at: string
        counterparty: string | null
        given_fmv: number | null
        received_fmv: number | null
        cash_boot: number | null
      }[]
    },
  })
}
```

No derivation needed — all list-view fields are direct columns on the `trades` table.

---

## UI

### Nav + Route

Add after Inventory in the NAV array:

```typescript
{ to: '/trades', icon: ArrowLeftRight, label: 'Trades' }
```

`ArrowLeftRight` is already imported in `src/pages/InventoryPage.tsx` but **not** in `Layout.tsx`. Import it there. Add route `/trades` → `<TradesPage />` in `App.tsx`.

### Table layout

```
┌──────────┬──────────────┬──────────┬──────────┬─────────┐
│ Date     │ Counterparty │ Gave     │ Received │ Boot    │
├──────────┼──────────────┼──────────┼──────────┼─────────┤
│ Sep 9    │ John D.      │ $120.00  │ $135.00  │ +$15.00 │
│ Aug 24   │ —            │ $80.00   │ $80.00   │ —       │
└──────────┴──────────────┴──────────┴──────────┴─────────┘
```

- Sticky `<thead>` consistent with other pages
- Boot column: green `+$X.XX` when `cash_boot > 0` (received cash), red `-$X.XX` when `cash_boot < 0` (paid cash), `—` when null or 0
- Clicking any row opens `TradeDetailSlideOver` with that trade's `id`
- **Empty state:** "No trades yet. Use 'Record Trade' on the Inventory page to log one."
- **Page footer:** `N trade` / `N trades` count

### Cache invalidation

Any mutation that creates or deletes a trade must invalidate `['trades']`. The relevant sites:
- Trade creation: `RecordTradeModal.tsx` — add `['trades']` invalidation in `onSuccess`
- Trade deletion: `TradeDetailSlideOver.tsx` — add `['trades']` invalidation in delete `onSuccess`

---

## Files

| Action | File |
|---|---|
| Modify | `src/lib/queries.ts` — add `useTrades()` |
| Create | `src/pages/TradesPage.tsx` |
| Modify | `src/components/Layout.tsx` — add `ArrowLeftRight` import + nav entry |
| Modify | `src/App.tsx` — add `/trades` route |
| Modify | `src/components/modals/RecordTradeModal.tsx` — add `['trades']` invalidation |
| Modify | `src/components/TradeDetailSlideOver.tsx` — add `['trades']` invalidation |

---

## Edge Cases

- **Trade with no counterparty:** Show `—` in Counterparty column.
- **Trade with `cash_boot = null` or 0:** Show `—` in Boot column.
- **Trade with null FMV fields:** Show `—` in Gave/Received columns.
- **No trades:** Empty state with guidance to use Inventory page.

---

## Out of Scope (v1)

- Filtering by date range or counterparty
- Sorting controls
- Edit trade from list (no edit flow exists — slide-over has delete only)
