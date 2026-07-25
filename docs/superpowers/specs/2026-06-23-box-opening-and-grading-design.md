# Box Opening & Grading — Inventory Cost Capitalization

**Status:** Partially implemented — **grading/cost-adjustments shipped 2026-07-26**; box opening still draft
**Date:** 2026-06-23
**Author:** Brainstormed with Claude

> **What shipped (2026-07-26).** The `lot_cost_adjustments` half: capitalizing grading, shipping-to-grader and other direct costs into a lot's `unit_cost`, with `initial_unit_cost` and the recompute-from-invariant rule exactly as specified below. See [`features/inventory.md`](../../features/inventory.md#capitalized-cost-adjustments-grading-shipping-to-grader).
>
> **Deviation from this spec:** `addLotCostAdjustment` does **not** always create a `cost_of_goods` transaction. It offers *create* or *link an existing one*, tracked on a `created_transaction` column that isn't in the table below. The spec predates live Plaid sync; always creating a row would double-deduct any grader fee paid on a synced card. Deletion honors the same distinction — a created transaction goes with the adjustment, a linked one stays.
>
> **Not built:** `box_openings`, the relative-sales-value allocation, `inventory_lots.box_opening_id`, `openBox`, and `OpenBoxModal`. Everything about them below is still a proposal.

## Background

The user resells sports cards. Two recurring workflows have no first-class support in the app:

1. **Opening a sealed box** that yields many individually saleable cards (one purchase → many distinct sale items at unequal values).
2. **Grading individual cards** (sending raw cards to PSA/BGS/SGC), which adds direct cost that prepares a specific card for resale.

Current workaround: the user logs the box as one `cost_of_goods` transaction with no item link, records sales without any cost basis, and expenses grading fees as `supplies`. This is tax-defensible but destroys per-item profitability, breaks FIFO inventory accounting, and overstates the `supplies` line on Schedule C.

## Tax method decision (locked in)

The user adopts **NIMS** — Non-Incidental Materials & Supplies under IRC §471(c)(1)(B)(ii) — for inventory. Under NIMS, inventory cost is deducted on Schedule C **when paid or used, whichever is later**. For a sealed box, "used" = opened. For grading, "paid" = when the grader is paid.

Key consequence: **per-card cost basis is for profitability reporting, not Schedule C COGS**. The box's full cost hits `cost_of_goods` on the open date regardless of how it's allocated across cards. Allocation only affects the Profitability dashboard and per-sale profit display.

## Accounting methods (CPA-approved)

### Box allocation → Relative Sales Value Method

Allocate box cost across resulting singles in proportion to each card's estimated fair market value:

```
card_basis = box_cost × (card_FMV / Σ all card FMVs)
```

Basis: Treas. Reg. §1.471-2(c) (reasonable inventory allocation); ASC 330-10-30 (relative-sales-value for joint products from common cost). This is the standard method for card/coin/comic dealers, mining joint products, and real estate subdividers.

**Fallback:** if `Σ FMVs = 0` (rare — entire box of pure commons), fall back to equal allocation. Surface a warning.

**Specific identification** (user enters $ basis per card directly) is also supported as an alternative input mode — same allocation math, but the user types dollar values that must sum to box cost rather than weights.

### Grading fees → Capitalized to specific lot

Grading fees + shipping-to-grader are direct costs to prepare a specific identifiable inventory item for sale. They are **added to the lot's `unit_cost`**, not expensed as `supplies`.

Basis: ASC 330-10-30-1 (inventory cost includes costs to bring asset to present location and condition); IRC §263A principle (small biz taxpayer exemption from full UNICAP doesn't change the costing logic).

**Schedule C treatment under NIMS:** post a `cost_of_goods` transaction for the grading fee at the time the grader is paid. The card's basis goes up by the same amount, and no double-counting occurs because Schedule C totals read from `transactions` while per-sale profitability reads from `inventory_movements.unit_cost`.

**Migration of past behavior:** grading fees previously categorized as `supplies` are not retroactively re-categorized by this feature. The user can manually recategorize past `supplies` rows or leave them as-is. Going forward, the new grading flow writes `cost_of_goods`.

## Data model changes

### New table: `box_openings`

Audit-trail record of a single box-opening event. One row per box opened.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | RLS-scoped |
| `created_at` | timestamptz | |
| `deleted_at` | timestamptz | soft delete |
| `opened_at` | date | when the box was physically opened — drives Schedule C date |
| `box_name` | text | "2024 Topps Series 1 Hobby Box" |
| `box_cost` | numeric | total $ allocated across resulting lots |
| `transaction_id` | uuid FK | nullable; FK to the `cost_of_goods` transaction created for this opening. `ON DELETE SET NULL`. |
| `allocation_method` | text | `'relative_fmv' \| 'specific_id' \| 'equal'` |
| `notes` | text | optional |

### New table: `lot_cost_adjustments`

Audit log of post-creation cost additions to a lot (grading, restoration, custom slabs, etc.). Append-only; deletion handled by `deleted_at`. The lot's `unit_cost` always reflects current all-in basis; this table records the history.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | RLS-scoped |
| `created_at` | timestamptz | |
| `deleted_at` | timestamptz | soft delete; reversing an adjustment soft-deletes here and recomputes lot `unit_cost` |
| `lot_id` | uuid FK | not null |
| `adjustment_type` | text | `'grading' \| 'shipping_to_grader' \| 'other'` |
| `amount` | numeric | always positive (basis increase); future negative adjustments out of scope v1 |
| `incurred_on` | date | when the fee was paid — drives Schedule C date |
| `transaction_id` | uuid FK | nullable; FK to the `cost_of_goods` transaction posted for this adjustment. `ON DELETE SET NULL`. |
| `grader` | text | nullable; `'PSA' \| 'BGS' \| 'SGC' \| ...` (free-text, suggested values in UI) |
| `grade_received` | text | nullable; user-entered after the card returns ("PSA 10") |
| `notes` | text | optional |

### Modified table: `inventory_lots`

Add nullable FK:

| column | type | notes |
|---|---|---|
| `box_opening_id` | uuid FK | nullable; set when this lot came from a `box_openings` row. `ON DELETE SET NULL` (preserves lot if opening event is deleted; user can re-link or leave orphaned). |
| `initial_unit_cost` | numeric | nullable; the per-unit basis at lot creation, before any `lot_cost_adjustments`. Stored explicitly so `unit_cost` can be recomputed from the invariant without inferring history. For pre-existing lots created before this feature ships, backfilled to equal `unit_cost`. |

`unit_cost` semantics unchanged: it is the **all-in current basis** per unit. Box allocation sets the initial value; each new `lot_cost_adjustments` row (not soft-deleted) contributes `amount / quantity_purchased` to it.

**Invariant (authoritative):** `unit_cost = (initial_basis_per_unit × quantity_purchased + Σ active adjustment amounts) / quantity_purchased`. Mutations that add or remove adjustments **recompute `unit_cost` from this invariant** rather than mutating it incrementally — avoids drift from rounding or missed updates. `initial_basis_per_unit` is reconstructed by reading the lot's current `unit_cost` minus the per-unit contribution of active adjustments at the time of the operation, OR — preferred — a new nullable `initial_unit_cost` column is added to `inventory_lots` to store it explicitly. **Decision:** add `initial_unit_cost` column; cheaper and more honest than reconstructing.

## Mutation layer changes (`src/lib/mutations.ts`)

### New: `openBox`

Single atomic-ish flow (best-effort; not wrapped in a server-side transaction in v1 — see Open Questions). Creates the box-opening event, the cost-of-goods transaction, items as needed, and one lot per card.

```ts
export async function openBox(params: {
  openedAt: string                          // 'yyyy-MM-dd'
  boxName: string
  boxCost: number
  allocationMethod: 'relative_fmv' | 'specific_id' | 'equal'
  notes?: string | null
  merchant?: string | null                  // for the COGS txn
  cards: Array<{
    itemId?: string | null                  // null = create new item
    newItemName?: string | null             // required if itemId is null
    newItemCategory?: string | null
    weight?: number                          // relative_fmv mode: any positive number
    specificCost?: number                    // specific_id mode: dollar basis (must sum to boxCost)
  }>
}): Promise<{ boxOpeningId: string; transactionId: string; lotIds: string[] }>
```

Steps:
1. Validate inputs (cards non-empty; allocation math is consistent; sums match `boxCost` for `specific_id`).
2. Compute per-card basis according to `allocationMethod`. For `relative_fmv`, fall back to equal if `Σ weight == 0`.
3. Create the `cost_of_goods` transaction (`amount: -boxCost`, `date: openedAt`, `merchant`, `notes`).
4. Insert the `box_openings` row, linking the transaction.
5. For each card: find-or-create the `items` row, then create an `inventory_lots` row with `quantity_purchased = 1`, `quantity_remaining = 1`, `unit_cost = computed_basis`, `transaction_id = (box txn)`, `box_opening_id = (new id)`.
6. Return ids.

Failure handling: if step 5 fails partway, the user is left with a partial opening. v1: surface the error and the partial state; let the user delete and retry. v2 candidate: move to an edge function with a real transaction.

### New: `addLotCostAdjustment`

```ts
export async function addLotCostAdjustment(params: {
  lotId: string
  adjustmentType: 'grading' | 'shipping_to_grader' | 'other'
  amount: number                            // positive
  incurredOn: string                        // 'yyyy-MM-dd'
  grader?: string | null
  gradeReceived?: string | null
  notes?: string | null
  merchant?: string | null                  // for the COGS txn
}): Promise<{ adjustmentId: string; transactionId: string }>
```

Steps:
1. Validate `amount > 0`, lot exists and is not deleted.
2. Create `cost_of_goods` transaction (`amount: -amount`, `date: incurredOn`, `merchant`).
3. Insert `lot_cost_adjustments` row linking the transaction.
4. Recompute lot `unit_cost` = current `unit_cost` + `amount / quantity_purchased`. Update lot row.

### New: `deleteLotCostAdjustment`

Soft-deletes the adjustment row, hard-deletes the linked `cost_of_goods` transaction (matching existing `deleteTransaction` behavior, which is hard-delete for this table), and recomputes the lot's `unit_cost` from scratch using the invariant below.

If the adjustment's linked transaction has already been edited (amount diverges from the adjustment's `amount`), abort with an error and ask the user to reconcile manually.

**Rationale for hard-deleting the transaction here:** deleting an adjustment means "I recorded this cost incorrectly and want it gone." The transaction was wrong too, so it should follow. This is the opposite of deleting a lot (below).

### Modified: `deleteLot`

No behavior change to the lot itself — already soft-deletes. But the soft-delete should not orphan adjustment rows; cascade soft-delete `lot_cost_adjustments` where `lot_id = id`. Their linked transactions are **not** auto-deleted.

**Rationale for keeping the transactions on lot delete:** deleting a lot usually means "I'm no longer tracking this card" (sold off-platform, given away, lost). The grading fee was still really paid, so the Schedule C deduction stays. Same logic as `deleteSale`: the sale row goes, but the underlying money movement is preserved unless it was a manual sale-linked row.

### Modified: `linkSaleToItem` / `recordSale` — no changes required

FIFO depletion of `inventory_lots` continues to work because lots from a box opening look identical structurally — they just have a populated `box_opening_id` and a populated `transaction_id` pointing at the shared box txn.

## UI changes

### New entry point: "Open Box" button on Inventory page

Top-right of `InventoryPage.tsx`, alongside the existing "Add Item" button.

### New modal: `OpenBoxModal` (`src/components/modals/OpenBoxModal.tsx`)

Two-step flow:

**Step 1 — Box header:**
- Box name (free text)
- Box cost ($)
- Opened on (date, defaults to today)
- Merchant (optional, defaults to box name)
- Notes (optional)
- Allocation method (segmented control): "Relative value" (default) / "Equal split" / "Specific $"

**Step 2 — Cards:**
- Repeating row of card pickers:
  - Item: `ItemPicker` (reuse existing) with inline "create new item" affordance
  - Mode-dependent input:
    - `relative_fmv`: "Est. value" numeric input (any positive number; the relative weight)
    - `equal`: no per-card input
    - `specific_id`: "Cost" numeric input ($ basis)
  - Computed basis (read-only column, updates live as user edits weights/cost)
- "+ Add card" button
- Footer:
  - Sum of allocated basis (must match `box_cost` for `specific_id`; equals `box_cost` automatically otherwise)
  - Warning if `relative_fmv` with all-zero weights → "Will fall back to equal allocation"
  - "Open box" submit button (disabled until validation passes)

### Expanded lot row on Inventory page

When viewing a lot that has `lot_cost_adjustments`, show a basis breakdown:
```
Basis: $26.67  ▾
  $6.67  Box open · 2026-03-12 · "2024 Topps Series 1 Hobby Box"
  $20.00 Grading · 2026-04-08 · PSA · Grade: 10
```

Add "Add cost adjustment" button on lot rows where `quantity_remaining > 0`. (Adjustments on fully sold lots are technically valid but rare; allow but warn.)

### New modal: `AddLotCostAdjustmentModal` (`src/components/modals/AddLotCostAdjustmentModal.tsx`)

Fields:
- Adjustment type (segmented: Grading / Shipping to grader / Other)
- Amount ($)
- Incurred on (date)
- Grader (free text with suggestions: PSA, BGS, SGC, CGC, HGA) — only for grading type
- Grade received (free text, optional, post-fact editable)
- Merchant (defaults to grader name for grading type, else free text)
- Notes (optional)

### Sale detail / Profitability changes — none required

The Profitability card and per-sale profit calc already use `inventory_movements.unit_cost`, which now correctly reflects all-in basis (box allocation + grading). No formula changes.

### Schedule C / Dashboard — no double-count

`computeScheduleC` reads from `transactions.cost_of_goods` and already includes both the box txn and the grading txns. It does **not** read from `inventory_movements`. So per-card basis remains a Profitability-only number; Schedule C is driven entirely by the transaction rows posted at open/grade time. Verified against existing logic in `docs/data-flows.md` (`computeProfitability` vs. `computeScheduleC` separation).

## Documentation updates (same PR)

Per `CLAUDE.md` doc-maintenance rule:

- `docs/supabase-schema.md` — document `box_openings`, `lot_cost_adjustments`, new `inventory_lots.box_opening_id` column.
- `docs/features/inventory.md` — document Open Box flow, basis-breakdown UI, grading capitalization.
- `docs/data-flows.md` — add "Opening a box" and "Capitalizing grading" sections; clarify that lot `unit_cost` is now an all-in basis figure with adjustment history.
- `docs/categories.md` — add note that `cost_of_goods` may now reflect grading fees previously categorized as `supplies`.
- `TASKS.md` — close any prior items superseded; add migration follow-up if needed.

## Out of scope (v1)

- **Partial box opening** (pull a few cards, leave box partially intact) — opening is all-or-nothing in v1.
- **Post-hoc card addition** to an existing box opening (rebalancing other lots' basis when adding a card later) — user creates a separate event or accepts the gap.
- **Selling a sealed box without opening it** — would require modeling boxes as their own inventory items. Defer until requested.
- **Negative cost adjustments** (refund from grader, write-down). Out of scope; user can manually adjust the lot.
- **Lot with `quantity_purchased > 1` being graded** — grading semantically applies to one card. v1 assumes box-opening lots are always `quantity = 1`; the adjustment modal does not enforce this but UX guidance suggests splitting the lot first. v2 candidate: a "split lot before grading" helper.
- **Cross-client (mobile) parity** — schema changes are additive and won't break the iOS app, but the iOS app gets no UI for these flows in this scope.
- **Edge function for atomic box-opening** — v1 does it client-side; v2 moves to an edge function for true atomicity.
- **Retroactive re-categorization** of historical `supplies` rows that were actually grading fees.

## Open questions for user review

1. **Allocation default**: spec defaults to `relative_fmv` with the FMV input labeled "Est. value." Acceptable, or default to `equal` and require an explicit switch to FMV mode?
2. **Card creation inside the open-box modal**: spec allows inline "create new item." Acceptable, or require items to be pre-created on the Inventory page?
3. **Grader options**: suggested list is PSA, BGS, SGC, CGC, HGA. Anything else worth pre-suggesting?
4. **Atomicity**: spec accepts a non-atomic v1 (partial failure leaves partial data). OK for now?
5. **Soft-delete cascade on lot**: when a lot is soft-deleted, the spec cascades to soft-delete its adjustment rows but leaves the linked COGS transactions alone. Right behavior, or should the transactions also be cleaned up?

## Success criteria

- User opens a $200 box → one `cost_of_goods` transaction of $200 on Schedule C, N items created (or linked), each with a lot whose `unit_cost` reflects relative-FMV allocation.
- User grades a card → one `cost_of_goods` transaction for the grading fee on Schedule C, that lot's `unit_cost` increased by the fee amount, an audit row recorded under the lot.
- User sells a card → existing `record_sale` flow works unchanged; Profitability dashboard shows revenue − fees − shipping − (allocated box basis + grading) as net profit.
- No double-counting on Schedule C (verified by hand for one box: sum of all transactions for the box and its graded cards equals exactly the cash out-of-pocket).
- Doc files under `docs/` updated in the same PR.
