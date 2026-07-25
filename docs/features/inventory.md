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

**Linked** — a **Funding** panel listing every `inventory_lot_transactions` row for the lot: merchant, date, `CategoryBadge`, source, that transaction's own total, and the amount it contributed. Each row's amount is click-to-edit (`updateLotTransactionAmount`) and carries its own remove ✕ (`unlinkLotFromTransaction(lotId, transactionId)`). The footer reads **Funded of $X**, green once the links sum to the lot's cost:

- within $0.01 → green, no warning
- under → amber "$X of this lot isn't funded yet — add the other payment method"
- over → amber "funding exceeds the lot cost by $X"

A lot can have **several funding sources**. The motivating case is a split-tender purchase: an eBay order paid $84.23 on a card (which Plaid syncs) and $29.65 from marketplace balance (which never touches a bank and must be entered by hand). **Add funding source** reopens the picker to attach the next one, defaulting its amount to whatever of the lot is still unfunded, capped at that transaction's own total. Already-linked transactions are filtered out of the candidate list.

This replaced an earlier cross-lot "Purchase allocation" panel that compared the sum of a transaction's lots against the transaction amount. That question — *has all of this purchase become inventory?* — now lives where it belongs, on the Expenses side in `TransactionInventorySection`, which sums `allocated_amount` per transaction. The lot panel answers the complementary question, *is this lot fully paid for?*, and neither double-counts a split lot.

The full **Unlink transaction** button at the bottom only applies when there's exactly one source; with several, remove them individually.

A blue notice appears when the lot's effective date disagrees with the transaction's, with a **Use tx date** action (`setLotPurchaseDate`). This is the cleanup path for lots linked before date-syncing existed — `AddLotModal` defaults new lots to *today*, so a lot entered now for an older purchase carries a date that misorders FIFO. Comparison is on the date part only, since `created_at` is a timestamp while `transactions.date` is `yyyy-MM-dd`.

**Unlinked** — a searchable picker over `useLotLinkCandidates()`: money-out transactions that are either **uncategorized or already Cost of Goods**, newest first, capped at 500. Rows already categorized as something else are treated as settled and hidden, as are transactions already funding this lot. Each row shows its current category (or an italic `Uncategorized`). Candidates whose absolute amount equals the lot total within $0.01 get a green "match" pill and are **sorted to the top**; everything else keeps the query's date-desc order (the sort is stable). Both the pill and the sort read the same `isAmountMatch` helper so they can't drift apart.

Search runs through the shared `matchesSearch`/`parseSearchTerms` helpers in [`src/lib/transactionSearch.ts`](../../src/lib/transactionSearch.ts) — the same ones the Expenses page uses — so **amounts, dates, and categories are searchable here too**, not just merchant. Typing `84.23` finds the card leg of a split purchase directly.

Linking **closes the panel**, same as it did before multi-source funding existed. Adding a second source is the uncommon case and stays one deliberate reopen away, rather than making every ordinary link end on a panel you have to dismiss.

Linking offers two default-on checkboxes, both applied by `linkLotToPurchase()`: **categorize as Cost of Goods** (see below) and **set the lot's purchase date to the transaction's**. Both are shown only for the *first* link — a second funding source shouldn't silently re-date a lot that's already anchored. Linking does *not* touch `purchase_date` unless that second box is ticked — the lot and transaction dates are genuinely different events (order placed vs. charge posted), so the overwrite is offered rather than forced.

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

## Capitalized cost adjustments (grading, shipping to grader)

A lot's cost doesn't stop at the purchase. Buy a raw card for $10, pay PSA $20 to grade it and $5 to ship it there, and that card's real cost is $35. `lot_cost_adjustments` records those later costs and folds them into the lot's basis.

**Why capitalize instead of expensing.** Both fees are direct costs of preparing one identifiable item for sale, which makes them inventory cost rather than an expense (ASC 330-10-30-1; the IRC §263A costing principle). The rule of thumb is freight-**in** vs freight-**out**: shipping a card *to the grader* capitalizes, shipping a sold item *to a buyer* stays `shipping_postage`. Beyond correctness, expensing severs the fee from the card, so per-item profit reports a margin that card never earned — capitalizing is what makes the profitability number true.

**No double deduction.** Schedule C totals read from `transactions`; per-sale profit reads from `inventory_movements` → `inventory_lots.unit_cost`. The `cost_of_goods` transaction is the deduction, the basis increase is a reporting figure, and the two tracks never meet. See [`docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md`](../superpowers/specs/2026-06-23-box-opening-and-grading-design.md) for the CPA-reviewed rationale.

### The deduction toggle

`AddLotCostAdjustmentModal` (opened by the receipt icon on any lot row) makes you choose where the deduction comes from — the fee is deductible exactly **once**:

- **Create a transaction** — posts a `cost_of_goods` row dated `incurred_on`. For cash/manual payments, or anything that hasn't synced.
- **Link an existing one** — points at a transaction already in the books, typically the Plaid-synced charge from the grader. Posts nothing. Candidates come from `useLotLinkCandidates()`, the same unscoped negative/uncategorized-or-COGS query the purchase-linking flow uses.

Without this choice, recording a grading fee paid by a synced card would deduct it twice. Which path was taken is stored on `created_transaction`, and it governs deletion: removing an adjustment deletes a transaction it *created* (that row was wrong too) but never one it merely *linked* (a real bank record that exists independently).

### The basis invariant

`unit_cost` is always the **all-in current basis** per unit, and is recomputed from scratch on every add and remove:

```
unit_cost = (initial_unit_cost × quantity_purchased + Σ active adjustments) / quantity_purchased
```

`inventory_lots.initial_unit_cost` stores the pre-adjustment basis so this is computable without inferring history (backfilled to `unit_cost` for existing lots). Recomputing rather than incrementing is deliberate: `basisFromAdjustments()` in [`src/lib/lotCost.ts`](../../src/lib/lotCost.ts) works in integer cents and rebuilds the figure each time, so a lot adjusted and un-adjusted repeatedly always lands back on exactly its original basis. An incremental version accumulates a rounding error every trip.

**Rounding.** For `quantity_purchased = 1` — grading a single identified card, the case this exists for — the math is exact. For multi-unit lots, 2dp per-unit money can't always express the true share, so `unitCost × qty` can sit up to `qty − 1` cents below the real total. `basisFromAdjustments` returns `totalBasis` separately for that reason, and the UI shows the total, which is the honest number.

### Display

A lot with adjustments gets a disclosure arrow on its Unit Cost cell, in both the item-grouped and date-ledger views. Expanding shows what the basis is made of:

```
Basis: $35.00
  $10.00  Purchase · 2026-03-12
  $20.00  Grading · 2026-04-08 · PSA · PSA 10
   $5.00  Shipping to grader · 2026-04-06   [linked txn]
```

Each adjustment row can be removed individually; deleting the lot cascades a soft-delete to its adjustments but **keeps** their transactions — the fee was really paid, so the deduction stands (same reasoning as `deleteSale`).

## Purchase date

`inventory_lots` has a `purchase_date date` column (nullable). All new lots get a `purchase_date` set from the date picker (defaults to today). Lots created before the column was added show their `created_at` date as a fallback. The `purchase_date` is editable via the Edit Lot modal and is what the page's "Purchase Date" column displays.

## Gaps vs. mobile (TASKS.md backlog)

No "low stock" threshold/alert. No personal-use-withdrawal/shrinkage adjustment type (needed for Schedule C Line 36 to correctly exclude those from COGS).
