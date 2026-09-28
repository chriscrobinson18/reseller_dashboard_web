# Lazy Box Breakdown — Design

_2026-09-28 · P2 feature · web-first_

---

## Overview

The current box breakdown flow requires planning all child lots upfront before any cards are sold. For card resellers, this is impractical: a box might yield 1–10 notable cards, pull counts aren't known in advance, and cards are often listed and sold over days or weeks.

This feature adds an **incremental breakdown mode**: a box opening is created as an open pool, and cards are added one at a time as they are pulled and sold. When the reseller is done, a close-out action writes off the remaining basis to COGS immediately (no bulk lot created — user never keeps bulk).

**Accounting method:** §471(c) NIMS. Each card's cost hits COGS at time of sale (FIFO depletion of its child lot). Remaining basis at close-out hits COGS as a bulk disposal write-off, which is correct when the remaining cards are genuinely discarded or given away.

The existing all-at-once breakdown flow is **unchanged** — both modes coexist.

---

## Data Model

### `box_openings` — one new column

```sql
alter table public.box_openings
  add column status text not null default 'open'
  check (status in ('open', 'closed'));

-- All existing breakdowns were finalized upfront
update public.box_openings set status = 'closed';
```

No other schema changes. The remaining pool balance is always derivable:

```
remaining_basis = box_opening.box_cost − sum(child_lot.unit_cost)
```

This is computed at read time from existing data — no denormalized column needed.

### Source lot depletion — unchanged

When a lazy breakdown starts, the source lot is immediately depleted (`quantity_remaining → 0`), same as the all-at-once flow. This prevents the source lot from being accidentally sold while the pool is active. The pool's basis lives in the `box_openings.box_cost` field until cards are pulled.

### Close-out transaction

When `closeBoxOpening()` is called and `remaining_basis > 0`, one `transactions` row is inserted:

| Column | Value |
|---|---|
| `user_id` | current user |
| `schedule_c_category` | `cost_of_goods` |
| `amount` | remaining basis (positive) |
| `source` | `manual` |
| `notes` | `"Box close-out: [box_name] — bulk write-off"` |
| `date` | today |

This puts the write-off on Schedule C Line 4 with a clear audit trail. If `remaining_basis = 0` (every penny was allocated to child lots), no transaction is created — just the status update.

---

## Mutations

### `startBoxOpening({ sourceLotId, openedAt, notes? })`

Creates a `box_openings` row with `status: 'open'` and no child lots. Immediately depletes the source lot (`quantity_remaining → 0`). Returns `{ boxOpeningId }`.

Invalidates: `['items']`, `['box-opening']`.

### `addPullToOpening({ boxOpeningId, itemId?, newItemName?, newItemCategory?, basis })`

Validates:
- Box opening exists and `status = 'open'`
- `basis > 0`
- `basis ≤ remaining_basis` — prevents over-allocating the pool
- Either `itemId` or `newItemName` is provided

Creates one `inventory_lots` row:
- `quantity_purchased: 1`
- `quantity_remaining: 1`
- `unit_cost: basis`
- `box_opening_id: boxOpeningId`
- `purchase_date: box_opening.opened_at`

If the source lot had an `inventory_lot_transactions` funding link, mirrors it onto the new child lot (same pattern as `openBox()`).

Returns `{ lotId }`.

Invalidates: `['items']`, `['box-opening']`.

### `closeBoxOpening({ boxOpeningId })`

1. Fetches box opening + all child lots
2. Computes `remaining = box_cost − sum(child_lot.unit_cost)`
3. If `remaining > 0`: inserts the write-off `transactions` row (see Data Model above)
4. Sets `box_openings.status = 'closed'`
5. Returns `{ remainingAmount }` for toast display

Invalidates: `['items']`, `['box-opening']`, `['transactions']` (write-off row).

### `openBox()` — unchanged

The existing all-at-once mutation sets `status: 'closed'` on the new `box_openings` row. All existing breakdowns continue to work without any migration or code change.

---

## UI

### `OpenBoxModal` — second entry point

After the user selects a source lot and date, present two action buttons:

- **"Add Cards Now"** — existing flow, all cards upfront. Calls `openBox()`, status `'closed'`.
- **"Start — Add As I Pull"** — calls `startBoxOpening()`, closes modal, immediately opens `BoxOpeningDetailSlideOver` for the new open breakdown.

The existing card-entry form is only shown when "Add Cards Now" is selected.

### `BoxOpeningDetailSlideOver` — open state additions

When `status = 'open'`:

- **"In Progress" badge** next to the box name (amber, same style as existing status badges)
- **Pool balance line:** `"Pool remaining: $48.00 of $80.00"` — shown below the cost section
- **"Add Pull" button** — primary action button, opens `AddPullModal`
- **"Close Box" button** — secondary/danger button. Confirm dialog: _"Write off $48.00 to COGS and close this box? This records the remaining basis as a bulk disposal."_ → on confirm, calls `closeBoxOpening()` → success toast: _"Box closed. $48.00 written off to COGS."_
- **Delete button** — disabled while `status = 'open'` (can't delete a box with potentially unsold child lots). Tooltip: "Close the box before deleting."

When `status = 'closed'`: existing behavior unchanged. Pool balance line and "Add Pull"/"Close Box" buttons are not shown.

### `AddPullModal` (new)

Minimal — two fields only:

1. **Item** — existing item picker (`ItemPicker` component) OR a "New item" text input + category selector (same pattern as `OpenBoxModal`'s card row)
2. **Basis** — dollar amount input. Helper text: `"$48.00 remaining in pool"`

On submit: calls `addPullToOpening()`. On success:
- Modal closes
- New child lot appears in the breakdown's card list in `BoxOpeningDetailSlideOver`
- An inline **"Record Sale →"** shortcut button appears next to the newly created lot row — tapping it opens the standard `RecordSaleModal` pre-populated with the lot's item. If the user isn't selling immediately, they ignore the shortcut.

### Inventory page — no changes

Open box openings already appear in the breakdown history panel. The "In Progress" badge on the slide-over is sufficient — no new list section needed.

---

## Edge Cases

- **`basis` exceeds remaining pool:** `addPullToOpening` rejects with a validation error. UI shows the remaining balance as a hint to prevent this.
- **Close box with $0 remaining:** Valid. No write-off transaction is inserted; the box is simply marked closed. Toast: _"Box closed. All basis allocated to pulls."_
- **Attempt to sell source lot while breakdown is open:** Not possible — source lot is immediately depleted to `quantity_remaining: 0` at `startBoxOpening()` time, same as the all-at-once flow.
- **Delete open box opening:** Blocked in UI (button disabled). If somehow attempted via API: only allowed if all child lots have `quantity_remaining = quantity_purchased` (none sold) — same guard as the existing `deleteBoxOpening`.
- **Allocation method:** Not set on lazy breakdowns (child lots have no shared allocation method — each basis is entered individually). `box_openings.allocation_method` stays null for lazy-mode openings, which is already allowed by the existing nullable constraint.

---

## Out of Scope (v1)

- "Sell immediately" checkbox in `AddPullModal` (user can tap "Record Sale →" shortcut instead — two taps)
- Editing a pull's basis after it's been added (delete + re-add)
- Partial close-out (close some of the pool, leave the rest open)
- Re-opening a closed breakdown
