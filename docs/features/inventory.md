# Inventory (`src/pages/InventoryPage.tsx`)

Item + lot management. The only page that uses the centralized `useItems()` hook from `src/lib/queries.ts` instead of a page-local fetch function.

## Data

- `useItems()` → `fetchItemsWithLots()`: fetches `items` joined with `inventory_lots(...)`, filters `deleted_at is null` on items, then client-side filters out soft-deleted lots per item (`.filter(l => !l.deleted_at)` — the join itself can't apply that filter). Ordered by item `name`.
- `itemUnitsInStock(item)` and `itemAvgCost(item)` (also in `queries.ts`) are the shared helpers for "units remaining" and "weighted-average unit cost" — reused by the page's `getItemSummary`-style totals. Note `itemAvgCost` weights by `quantity_purchased`, not `quantity_remaining` — it's "what did this item cost on average across all purchases ever," not "average cost of what's left."

## List view

- Expandable rows (`expandedIds: Set<string>`, click anywhere on the item row to toggle) revealing a sub-table of that item's lots.
- Header totals: item count, total units in stock (sum across ALL items' lots, not just filtered/visible ones), total value at cost.
- Per-item row: name, category (free-text product category — NOT a Schedule C category), units in stock, value at cost, avg cost, lot count, expand chevron. "Sold out" label when `unitsInStock === 0`.
- Per-lot sub-row: date added (`created_at` — there's no separate purchase date, see schema gap below), purchased/remaining quantities, unit cost, value (`remaining * unit_cost`), purchase-transaction link status (`Linked` vs. italic `No purchase record`), and a "% sold" progress bar (`(purchased - remaining) / purchased * 100`).
- "Add purchase lot" row always rendered at the bottom of an expanded item's lot list, even when the item has zero lots.

## Mutations

- `createItem`/`updateItem`/`deleteItem` (soft delete) — straightforward, via modals `AddItemModal`/`EditItemModal`.
- `createLot`/`updateLot`/`deleteLot` (soft delete) via `AddLotModal`/`EditLotModal`. `createLot` accepts an optional `transactionId` to link the new lot directly to a COGS purchase transaction at creation time — the alternative path (linking an *existing* lot after the fact) is `linkLotToTransaction`/`unlinkLotFromTransaction`, exposed via `TransactionInventorySection` on the Expenses page, not from here.
- Edit/delete actions on item and lot rows only appear on hover (`opacity-0 group-hover:opacity-100`) — no keyboard/touch-friendly affordance currently.

## Known schema gap affecting this page

`inventory_lots` has no `purchase_date` column — the "Date Added" column shown is actually `created_at`, which breaks correct FIFO ordering if a lot is entered into the system after the fact for a date in the past. This is a tracked schema gap (TASKS.md), not a UI bug — fixing it requires a migration plus updating `createLot`/`updateLot` and this page's date column.

## Gaps vs. mobile (TASKS.md backlog)

No "low stock" threshold/alert. No personal-use-withdrawal/shrinkage adjustment type (needed for Schedule C Line 36 to correctly exclude those from COGS).
