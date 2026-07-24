# Inventory (`src/pages/InventoryPage.tsx`)

Item + lot management. The only page that uses the centralized `useItems()` hook from `src/lib/queries.ts` instead of a page-local fetch function.

## Data

- `useItems()` → `fetchItemsWithLots()`: fetches `items` joined with `inventory_lots(...)`, filters `deleted_at is null` on items, then client-side filters out soft-deleted lots per item (`.filter(l => !l.deleted_at)` — the join itself can't apply that filter). Ordered by item `name`.
- `itemUnitsInStock(item)` and `itemAvgCost(item)` (also in `queries.ts`) are the shared helpers for "units remaining" and "weighted-average unit cost" — reused by the page's `getItemSummary`-style totals. Note `itemAvgCost` weights by `quantity_purchased`, not `quantity_remaining` — it's "what did this item cost on average across all purchases ever," not "average cost of what's left."

## List view

- Expandable rows (`expandedIds: Set<string>`, click anywhere on the item row to toggle) revealing a sub-table of that item's lots.
- Header totals: item count, total units in stock (sum across ALL items' lots, not just filtered/visible ones), total value at cost.
- Per-item row: name, category (free-text product category — NOT a Schedule C category), units in stock, value at cost, avg cost, lot count, expand chevron. "Sold out" label when `unitsInStock === 0`.
- Per-lot sub-row: purchase date (`purchase_date`, falling back to `created_at` for lots entered before the column was added), purchased/remaining quantities, unit cost, value (`remaining * unit_cost`), purchase-transaction link status (`Linked` vs. italic `No purchase record` — clickable, see below), and a "% sold" progress bar (`(purchased - remaining) / purchased * 100`).
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

## Purchase Tx cell → `LotTransactionSlideOver`

The "Purchase Tx" cell in each lot sub-row is a button opening `LotTransactionSlideOver` (`src/components/LotTransactionSlideOver.tsx`), which handles both states.

**Linked** — shows the transaction (merchant, date, amount, `CategoryBadge`, source, notes) plus an **Unlink transaction** action (`unlinkLotFromTransaction`). Warns in amber when the lot total (`quantity_purchased × unit_cost`) differs from the transaction amount by ≥ $0.01, since one purchase legitimately covers several lots.

**Unlinked** — a merchant-searchable picker over `useLotLinkCandidates()`: money-out transactions that are either **uncategorized or already Cost of Goods**, newest first, capped at 500. Rows already categorized as something else are treated as settled and hidden. Each row shows its current category (or an italic `Uncategorized`), and candidates whose absolute amount equals the lot total within $0.01 get a green "match" pill.

### Why the picker isn't COGS-only

This flow exists to reconcile **backwards** — the user knows they bought inventory and goes hunting for the bank transaction, which in a messy ledger is usually still uncategorized. A COGS-only picker would be empty in exactly the case the feature is for. So the picker includes uncategorized rows, and linking offers a default-on **"Also categorize it as Cost of Goods"** checkbox; `linkLotToPurchase()` in `mutations.ts` performs the link and the recategorization together. Unticking links without touching the category, which leaves a lot pointing at a non-COGS transaction — valid mid-cleanup, but it will under-report Part III until fixed.

Both paths invalidate `['items']`, `['lots-for-tx']`, `['transactions']`, and `['lot-link-candidates']` so this page, the Expenses page, and `TransactionInventorySection` stay in sync.

`useTransaction(id)` (in `queries.ts`) fetches the linked transaction directly by id rather than reusing the Expenses page's fetch — that one is period-scoped (YTD by default), so a lot linked to an older purchase would otherwise not be found. `useLotLinkCandidates()` is unscoped for the same reason.

## Purchase date

`inventory_lots` has a `purchase_date date` column (nullable). All new lots get a `purchase_date` set from the date picker (defaults to today). Lots created before the column was added show their `created_at` date as a fallback. The `purchase_date` is editable via the Edit Lot modal and is what the page's "Purchase Date" column displays.

## Gaps vs. mobile (TASKS.md backlog)

No "low stock" threshold/alert. No personal-use-withdrawal/shrinkage adjustment type (needed for Schedule C Line 36 to correctly exclude those from COGS).
