# Inventory (`src/pages/InventoryPage.tsx`)

Item + lot management. The only page that uses the centralized `useItems()` hook from `src/lib/queries.ts` instead of a page-local fetch function.

## Data

- `useItems()` → `fetchItemsWithLots()`: fetches `items` joined with `inventory_lots(...)`, filters `deleted_at is null` on items, then client-side filters out soft-deleted lots per item (`.filter(l => !l.deleted_at)` — the join itself can't apply that filter). Ordered by item `name`.
- `itemUnitsInStock(item)` and `itemAvgCost(item)` (also in `queries.ts`) are the shared helpers for "units remaining" and "weighted-average unit cost" — reused by the page's `getItemSummary`-style totals. Note `itemAvgCost` weights by `quantity_purchased`, not `quantity_remaining` — it's "what did this item cost on average across all purchases ever," not "average cost of what's left."

## Views

A segmented control next to the search box switches between two views over the same `useItems()` data (`view: 'item' | 'date'`, local state — not persisted or in the URL). The search box filters items by name/category in both.

- **By Item** (default) — the expandable item/lot tree described below.
- **By Date** — `LotLedger`, a flat newest-first ledger of *every* lot across all items, one row per lot with no grouping or subtotal rows. Sorted by effective lot date (`purchase_date ?? created_at`), tie-broken on `created_at`. This is the shape to use when reconciling purchases against bank transactions chronologically; the Purchase Tx cell, trade pill, and edit/delete actions behave identically to the item view.

The footer count reflects the active view — items in By Item, lots in By Date.

## List view (By Item)

- Expandable rows (`expandedIds: Set<string>`, click anywhere on the item row to toggle) revealing a sub-table of that item's lots.
- Header totals: item count, total units in stock (sum across ALL items' lots, not just filtered/visible ones), total value at cost.
- Per-item row: name, category (free-text product category — NOT a Schedule C category), units in stock, value at cost, avg cost, lot count, expand chevron. "Sold out" label when `unitsInStock === 0`.
- Per-lot sub-row: purchase date (`purchase_date`, falling back to `created_at` for lots entered before the column was added), purchased/remaining quantities, unit cost, value (`remaining * unit_cost`), purchase-transaction link status (`Linked` vs. italic `No purchase record` — clickable, see below), and a "% sold" progress bar (`(purchased - remaining) / purchased * 100`).
- "Add purchase lot" row always rendered at the bottom of an expanded item's lot list, even when the item has zero lots.

## Mutations

- `createItem`/`updateItem`/`deleteItem` (soft delete) — straightforward, via modals `AddItemModal`/`EditItemModal`.
- `createLotsForPurchase`/`updateLot`/`deleteLot` (soft delete) via `AddLotModal`/`EditLotModal`. `createLotsForPurchase` accepts an optional `transactionId` to link the new lot directly to a COGS purchase transaction at creation time — the alternative path (linking an *existing* lot after the fact) is `linkLotToTransaction`/`unlinkLotFromTransaction`, exposed via `TransactionInventorySection` on the Expenses page and via the Purchase Tx cell here.
- There is deliberately **no** single-lot `createLot` primitive. Every creation path goes through `createLotsForPurchase` so the penny-splitting below can't be bypassed (the trade flow inserts its own rows directly, since FMV allocation is its own calculation).
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

**Linked** — shows the transaction (merchant, date, amount, `CategoryBadge`, source, notes) plus an **Unlink transaction** action (`unlinkLotFromTransaction`), followed by a **Purchase allocation** panel.

That panel fetches *every* lot on the transaction (`fetchLotsForTransaction`, cache key `['lots-for-tx', txId]`, shared with `TransactionInventorySection`), lists them with the clicked one marked `(this lot)`, and compares their **sum** against the transaction amount. Reconciliation is deliberately an aggregate check — one purchase routinely covers several lots, so comparing a single lot against the whole transaction amount flags every legitimate multi-lot purchase as a mismatch. Only the aggregate is warned on:

- within $0.01 → the allocated figure turns green, no warning
- under → amber "$X of this purchase isn't assigned to inventory yet"
- over → amber "the lots exceed the transaction total by $X"

A blue notice appears above the allocation panel when the lot's effective date disagrees with the transaction's, with a **Use tx date** action (`setLotPurchaseDate`). This is the cleanup path for lots linked before date-syncing existed — `AddLotModal` defaults new lots to *today*, so a lot entered now for an older purchase carries a date that misorders FIFO. Comparison is on the date part only, since `created_at` is a timestamp while `transactions.date` is `yyyy-MM-dd`.

**Unlinked** — a merchant-searchable picker over `useLotLinkCandidates()`: money-out transactions that are either **uncategorized or already Cost of Goods**, newest first, capped at 500. Rows already categorized as something else are treated as settled and hidden. Each row shows its current category (or an italic `Uncategorized`). Candidates whose absolute amount equals the lot total within $0.01 get a green "match" pill and are **sorted to the top**; everything else keeps the query's date-desc order (the sort is stable). Both the pill and the sort read the same `isAmountMatch` helper so they can't drift apart.

Linking offers two default-on checkboxes, both applied by `linkLotToPurchase()`: **categorize as Cost of Goods** (see below) and **set the lot's purchase date to the transaction's**. Linking does *not* touch `purchase_date` unless that second box is ticked — the lot and transaction dates are genuinely different events (order placed vs. charge posted), so the overwrite is offered rather than forced.

### Why the picker isn't COGS-only

This flow exists to reconcile **backwards** — the user knows they bought inventory and goes hunting for the bank transaction, which in a messy ledger is usually still uncategorized. A COGS-only picker would be empty in exactly the case the feature is for. So the picker includes uncategorized rows, and linking offers a default-on **"Also categorize it as Cost of Goods"** checkbox; `linkLotToPurchase()` in `mutations.ts` performs the link and the recategorization together. Unticking links without touching the category, which leaves a lot pointing at a non-COGS transaction — valid mid-cleanup, but it will under-report Part III until fixed.

Both paths invalidate `['items']`, `['lots-for-tx']`, `['transactions']`, and `['lot-link-candidates']` so this page, the Expenses page, and `TransactionInventorySection` stay in sync.

`useTransaction(id)` (in `queries.ts`) fetches the linked transaction directly by id rather than reusing the Expenses page's fetch — that one is period-scoped (YTD by default), so a lot linked to an older purchase would otherwise not be found. `useLotLinkCandidates()` is unscoped for the same reason.

## Lot cost entry and penny splitting

`AddLotModal` takes cost as either **total paid** (default) or **cost per unit**, toggled by a segmented control; either way it resolves to a lot total. `TransactionInventorySection` on the Expenses page is total-only, and offers a "Use $X" shortcut that fills in the transaction's still-unallocated remainder.

`unit_cost` is 2dp per-unit money, so a total that doesn't divide evenly can't be represented by one lot: 3 for $10.00 at $3.33/unit is a $9.99 lot, which under-reports COGS by a cent and stops the purchase reconciling against the $10.00 transaction. `splitLotCost()` (`src/lib/lotCost.ts`) instead pushes the remainder cents onto the trailing units and returns **cost tiers**:

```
splitLotCost(10, 3) → [ { quantity: 2, unitCost: 3.33 },
                        { quantity: 1, unitCost: 3.34 } ]   // = $10.00 exactly
```

**Each tier becomes its own `inventory_lots` row** — one row carries a single `unit_cost`, so an uneven purchase legitimately produces two lot rows sharing an item, purchase date, and `transaction_id`. Both modals preview this before submit so the extra row isn't a surprise. The cheaper tier is ordered first, so FIFO consumes base-priced units before rounded-up ones.

`splitLotCost` is covered by `src/lib/__tests__/lotCost.test.ts`, including a sweep asserting the tiers always sum back to the requested total across quantities 1–25.

## Purchase date

`inventory_lots` has a `purchase_date date` column (nullable). All new lots get a `purchase_date` set from the date picker (defaults to today). Lots created before the column was added show their `created_at` date as a fallback. The `purchase_date` is editable via the Edit Lot modal and is what the page's "Purchase Date" column displays.

## Gaps vs. mobile (TASKS.md backlog)

No "low stock" threshold/alert. No personal-use-withdrawal/shrinkage adjustment type (needed for Schedule C Line 36 to correctly exclude those from COGS).
