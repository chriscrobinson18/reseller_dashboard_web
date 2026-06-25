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

## Recording a trade

A **"Record Trade"** button next to "Add Item" in the page header opens `RecordTradeModal` (`src/components/modals/RecordTradeModal.tsx`). See [data-flows.md](../data-flows.md#recording-a-trade-recordtrade-in-mutationsts) for the full mutation sequence.

### `RecordTradeModal` UX

Single-step modal (wider than a standard modal). Fields:

- **Header:** trade date (defaults today), counterparty (free text, optional), FMV source notes (optional but nudged — placeholder `"e.g. 'eBay sold comps saved'"` with inline hint "Recommended for IRS defensibility"), notes (optional).
- **"You gave" section:** repeating rows of `ItemPicker` (restricted to items with `quantity_remaining > 0`) + quantity + FMV per unit + read-only line total. "+ Add line" button. Subtotal shown.
- **"You received" section:** repeating rows of `ItemPicker` with an inline "+ Create new item" affordance that expands an inline name input (no separate modal). Quantity + FMV per unit (becomes `unit_cost` on the new lot) + read-only line total. "+ Add line" button. Subtotal shown.
- **"Cash boot" section** (collapsed by default): toggle "Cash changed hands?" expands a direction segmented control ("I paid" / "I received") + amount field.
- **Footer — live balance:** `Given $X + Paid $Y = Received $Z + Received cash $W`. Green check when balanced (within $0.01); red warning with specific delta otherwise. "Record trade" submit button is disabled until balanced and both sides have at least one line.

A small **info** button at the top-right of the modal opens an in-place help popover covering: the FMV-anchored barter rule, the balance equation (given + cash paid = received + cash received), the Schedule C wash for the two non-cash legs, FMV-source-note defensibility, and the delete-and-re-record edit path.

### Trade-acquired lot marker

Lots with `trade_id != null` display a small purple **"Trade"** pill in the lot sub-row (same visual treatment as status badges). Clicking the pill opens `TradeDetailSlideOver` (`src/components/TradeDetailSlideOver.tsx`).

### `TradeDetailSlideOver`

Read-only slide-over (drawer pattern). Shows trade date, counterparty, FMV source notes, notes; given-side and received-side line items with links to the sale/item; cash boot amount and link to the bank transaction if present; all linked transactions (income, COGS, cash boot). **Delete trade** button → `ConfirmDialog` with lifecycle and FIFO-reversal warnings; disabled if any received lot has been depleted.

## Known schema gap affecting this page

`inventory_lots` has no `purchase_date` column — the "Date Added" column shown is actually `created_at`, which breaks correct FIFO ordering if a lot is entered into the system after the fact for a date in the past. This is a tracked schema gap (TASKS.md), not a UI bug — fixing it requires a migration plus updating `createLot`/`updateLot` and this page's date column.

## Gaps vs. mobile (TASKS.md backlog)

No "low stock" threshold/alert. No personal-use-withdrawal/shrinkage adjustment type (needed for Schedule C Line 36 to correctly exclude those from COGS).
