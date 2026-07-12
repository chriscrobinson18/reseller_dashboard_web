# Returns & Refunds

**Status:** Manual path shipped 2026-07-10 (PR #2, branch `claude/tasks-md-review-5c6a7l`). CSV-reconciliation layer proposed — not yet built.
**Date:** 2026-07-10
**Author:** Brainstormed with Claude

> **Decision provenance.** The three central forks below (sourcing model,
> apply-vs-review, doc scope) were selected as recommended defaults during the
> brainstorm and are marked **(proposed)** where they describe unbuilt work.
> Redirect any of them before the CSV layer is implemented.

## Background

Returns are the last unbuilt piece of the core sell-side workflow (TASKS.md P1
"Returns → Return/refund UI"). The `record_return` edge function was fixed and
redeployed in the 2026-06-23 P0 tax-correctness pass (v21) — cost basis restored
at the lot's original `unit_cost`, refund posted as a `returns_allowances` Part I
line rather than netted into gross receipts — but nothing in either client called
it. This spec covers the UI + data flow that now does.

The dominant real-world workflow is **marketplace-sourced**: a seller's eBay /
Amazon transaction report already contains, for a returned order, the original
sale line, a refund line (negative), and one or two shipping-label lines
(outbound label + return label). The seller pays for the return label, so a
returned sale frequently nets to a **negative payout**. The lowest-lift path is
therefore to map returns off those imported transaction rows rather than ask the
user to re-key them. This spec resolves how to do that **without** losing the
inventory-restoration (COGS) correctness that only `record_return` provides.

## The central decision: how returns are sourced

There are three sourcing models. The correctness pivot is **inventory
restoration**: the only reason `record_return` exists is to add the returned
quantity back onto its original lot(s) at the original `unit_cost`, so
`quantity_remaining` and Schedule C Part III (COGS) stay correct. This is the
same class of bug the P0 pass fixed for sale deletion (`reverse_sale`).

| Model | Data-entry lift | Inventory correct? | Verdict |
|---|---|---|---|
| **A. Fully CSV-derived / computed** — `return_status`/`refunded_amount` computed from linked refund transactions; no `returns` row, no `record_return` | Lowest | ❌ nothing restores the lot; returned item shows as sold forever, overstating COGS | Rejected — re-introduces a P0-class bug |
| **B. Manual-only** | Highest (re-key every return) | ✅ | Shipped as the primitive, insufficient alone |
| **C. Hybrid (chosen)** — manual `record_return` is the inventory-restoring primitive; a CSV reconciliation layer detects refund + return-shipping rows and routes them through the same return logic, re-tagging the existing CSV transactions instead of duplicating | Low | ✅ | **Chosen** |

**Chosen: C (hybrid).** `record_return` / `reverse_return` remain the single
correctness-bearing primitive. `sales.return_status` / `refunded_quantity` /
`refunded_amount` stay **authoritative columns on the sale** (set by whichever
path fired), so the FIFO reversal always has a home. Net payout is *computed*
from linked transactions (already shipped — see below), because that part has no
correctness hole.

## Design constraints

- **Inventory-restoration is non-negotiable.** Every return path — manual or
  CSV — must go through the `record_return` FIFO-reversal logic. No path may set
  `return_status` without restoring the lot.
- **1099-K correctness.** Refunds post to a distinct `returns_allowances` Part I
  line, never netted into `payout` gross receipts. (Guardrail from the P0 spec,
  item #4.) Return-shipping labels post to `shipping_postage` (Part II expense,
  deductible) — a *different* tax line from the refund, so they are tracked
  separately, not folded into `refund_amount`.
- **One active return per sale (v1).** The edit flow assumes a sale has at most
  one return event. Multiple sequential partial returns against one sale are out
  of scope for v1 (see Out of scope). `fetchActiveReturn` takes the most-recent
  `returns` row.
- **No duplication on reconciliation.** The manual path *creates* the refund /
  return-shipping transactions; the CSV path *already has* them and must
  *re-tag* (attach `related_sale_id` + correct `schedule_c_category`), never
  insert a second copy.
- **Net payout reflects reality.** A sale's Net Payout must sum *all* linked
  transactions (payout + fees + outbound shipping + refund + return shipping) so
  a return that cost more than it refunded shows as negative.

## Data model

No new tables beyond `returns` (already exists, used by `record_return`). No
schema migration for the shipped manual path.

### `returns` (existing)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | RLS-scoped |
| `sale_id` | uuid FK → `sales` | |
| `quantity` | int | units returned |
| `refund_amount` | numeric | buyer refund (excludes return-shipping label) |
| `reason` | text NULL | optional |
| `source` | text | `'manual'` today; `'csv_import'` for the reconciliation layer |
| `created_at` | timestamptz | `fetchActiveReturn` orders by this desc |

### `sales` (existing columns, authoritative)

`return_status` (`'none' | 'partial' | 'full'`), `refunded_quantity`,
`refunded_amount`, `inventory_status` (`→ 'reconciled'` after a return). Set by
`record_return`; decremented/reset by `reverse_return`.

### `transactions` linkage (existing columns)

- `related_sale_id` — links refund / return-shipping / payout / fee / outbound-shipping rows to the sale. **The join key for Net Payout.**
- `type` — `'refund'` for both the refund and the return-shipping rows the return path inserts.
- `schedule_c_category` — `'returns_allowances'` (the refund) vs `'shipping_postage'` (the return label). This pair distinguishes the two `type='refund'` rows.
- `external_order_id` (on `sales`) / marketplace order id on CSV transaction rows — **the match key for the CSV reconciliation layer** (proposed).
- `csv_transaction_id`, `parent_settlement_id` — CSV-import linkage columns, already present, exercised by the reconciliation layer (proposed).

## Shipped: the manual path (2026-07-10)

### Edge functions

- **`record_return`** (v21+, `supabase/functions/record_return/`) — validates
  `quantity ≤ sale.quantity − refunded_quantity`; inserts a `returns` row;
  updates the sale's refund totals + `return_status` (`full` when
  `newRefundedQty === sale.quantity`, else `partial`) + `inventory_status =
  'reconciled'`; reverses `inventory_movements` **LIFO**, restoring
  `quantity_remaining` on each source lot at the lot's original `unit_cost`
  (fully-reversed movements deleted, partial ones decremented); inserts a
  `returns_allowances` refund transaction (`amount = −refund_amount`); and, when
  `return_shipping_cost > 0`, a second `shipping_postage` transaction
  (`amount = −return_shipping_cost`, `type='refund'`).
- **`reverse_return`** (`supabase/functions/reverse_return/`) — the inverse:
  re-depletes inventory FIFO, decrements the sale's refund totals / recomputes
  `return_status`, deletes the linked refund + return-shipping transactions,
  deletes the `returns` row. Backs the "edit a return" flow.

### Mutations (`src/lib/mutations.ts`)

- `recordReturn({ saleId, quantity, refundAmount, returnShippingCost?, reason? })` → invokes `record_return`.
- `reverseReturn(returnId)` → invokes `reverse_return`.
- `fetchActiveReturn(saleId)` → most-recent `returns` row + summed `shipping_postage` refund transactions, shaped as `ActiveReturn` for the edit form pre-fill.

### UI

- **`ProcessReturnModal`** (`src/components/modals/ProcessReturnModal.tsx`) —
  one component, two modes keyed on `sale.return_status !== 'none'`:
  - **New return:** qty capped at `sale.quantity − refunded_quantity`.
  - **Edit return:** loads `fetchActiveReturn`, pre-fills qty / refund /
    return-shipping / reason; qty cap relaxes to the full `sale.quantity`
    because edit is implemented as **reverse-then-re-record** (`reverseReturn`
    then `recordReturn` in one `mutationFn`), so the whole sale is eligible
    again. This mirrors the codebase's trade-edit "delete + re-record" pattern —
    avoids fragile partial-FIFO-adjustment math.
  - Fields: Quantity, Refund Amount, **Return Shipping Cost** ("what you paid to
    ship the item back, if any"), Reason (optional).
- **`SaleDetail`** (`SalesPage.tsx`) — "Process Return" / "Edit Return" action,
  hidden when `return_status === 'full'` or the sale is trade-linked. Return
  info box shows qty + amount refunded.
- **Net Payout** — `fetchSales` now also fetches every transaction with
  `related_sale_id in (…)` and sums `amount` per sale into `netPayoutBySale`;
  `netPayoutFor(sale)` returns that sum, **falling back** to `sale.net_payout`
  (then `sale_price − fees`) for sales with no linked rows (CSV-imported sales
  pre-reconciliation). Renders **red when negative** in both the table column
  and the detail grid. This is what surfaces the "returns often net negative"
  reality the feature was requested for.

## Proposed: the CSV reconciliation layer

*(Not built. Depends on the P1 "Marketplace CSV import" + "Settlement Status
view" items. This section specifies the contract the returns feature needs from
them.)*

### Detection

During `import_marketplace_csv` (or a follow-up `syncCSVReturnsToSales` pass,
mirroring the existing `syncCSVOrdersToSales`), classify imported transaction
rows:

- **Refund row** — negative amount whose marketplace record type / reason marks
  it a refund, carrying an order id that matches an existing `sales.external_order_id`.
- **Return-shipping row** — a shipping-label charge tied to the same order id,
  distinguishable from the *outbound* label (eBay/Amazon mark return labels; if a
  platform doesn't, treat any post-sale label on a refunded order as return
  shipping).

### Matching

Match refund + return-shipping rows to a sale by `external_order_id`. Group by
order id so one order's refund + label(s) form a single candidate return.

### Apply vs. review — **review queue (proposed)**

Detected returns land in a **"Needs review" reconciliation list** (reuse the
planned Settlement Status view's segmented-platform + section pattern) rather
than auto-mutating inventory on import. The user confirms the sale match and
quantity, then the row applies by calling the **same `recordReturn`** primitive
— except reconciliation passes `source: 'csv_import'` and the pre-existing CSV
transaction ids so the function **re-tags** those rows (`related_sale_id` +
`returns_allowances`/`shipping_postage`) instead of inserting new ones.

Rationale for review-first: multi-item orders share one order id, so a refund
can't always be attributed to a single sale/lot automatically; auto-mutating
FIFO on import is hard to undo if mis-matched. Unambiguous single-item single-sale
orders *may* later be promoted to auto-apply-with-exception-flagging, but v1 of
the layer is review-gated.

### `record_return` contract change (proposed)

Add optional params so the same function serves both callers without
duplicating transactions:

- `source: 'csv_import'`
- `refund_transaction_id?` / `return_shipping_transaction_id?` — when present,
  `record_return` **updates** those existing rows (set `related_sale_id`,
  `schedule_c_category`) instead of inserting; the FIFO reversal + sale-column
  updates are unchanged. Guard against double-apply: if the sale already has a
  `returns` row for the same `csv_transaction_id`, no-op.

## Edge cases

- **Return costs more than it refunded** (return label > refund) → Net Payout
  negative; renders red; `returns_allowances` (Part I, reduces receipts) and
  `shipping_postage` (Part II expense) land on different Schedule C lines
  correctly. Primary motivating case.
- **Full return** → `return_status = 'full'`; sale excluded from revenue /
  profitability aggregates (`sales.filter(s => s.return_status !== 'full')`);
  Process Return button hidden.
- **Edit reduces quantity** → reverse-then-re-record restores all units, then
  re-depletes the smaller qty; net inventory correct.
- **Trade-linked sale** → return UI hidden; trades are reversed via the trade,
  not per-leg.
- **Oversold sale returned** → `inventory_movements` may be fewer than
  `sale.quantity`; `record_return` restores only what was actually depleted
  (`units_restored` in the response can be < `quantity`). Acceptable.
- **CSV refund with no matching sale** (order never imported as a sale) → stays
  in the review queue as unmatched; user links a sale or leaves it as a bare
  `returns_allowances` transaction. (proposed)
- **Multi-item order, partial refund** → review queue requires the user to pick
  which sale/line the refund applies to. (proposed)
- **Double import** of the same CSV → `csv_transaction_id` / existing-`returns`
  guard prevents a second return being applied. (proposed)

## Out of scope (v1)

- Multiple sequential returns per sale (one active return assumed;
  `fetchActiveReturn` takes the latest). A true return *history* list is a v2.
- Auto-apply of CSV-detected returns without review.
- Restocking-fee modeling as its own tax line.
- iOS return UI (schema is additive; iOS reads `returns` without a UI).
- Return *reason* analytics / reporting.
- Partial refund of a partially-shipped multi-unit order at sub-lot granularity
  beyond FIFO/LIFO reversal.

## Documentation updates (same PR as each stage)

Per `CLAUDE.md` doc-maintenance rule:

- **`docs/features/sales.md`** — Process Return / Edit Return UI, net-payout-from-transactions, negative payout. *(done for the manual path.)*
- **`docs/supabase-schema.md`** — document the `returns` table in the main table
  section; note `record_return` v21+ return-shipping behavior and the
  `reverse_return` function; when the CSV layer lands, document the
  `csv_transaction_id` reconciliation guard.
- **`docs/data-flows.md`** — the "Revenue net of returns" section already covers
  the `returns_allowances` bucketing; extend with the return-shipping
  `shipping_postage` row and the Net Payout summation.
- **`docs/categories.md`** — confirm `returns_allowances` + `shipping_postage`
  descriptions cover the return case.
- **`TASKS.md`** — strike P1 "Return/refund UI" (done); add a P1/P2 item for the
  CSV return-reconciliation layer, dependent on "Marketplace CSV import" +
  "Settlement Status view".

## Resolved design decisions (from brainstorm)

1. **Sourcing model:** hybrid — manual `record_return` is the inventory-restoring primitive; CSV reconciliation re-tags existing marketplace transactions through the same primitive. `return_status`/refund totals authoritative on the sale; net payout computed from linked transactions. *(A rejected for the COGS hole; B insufficient alone.)*
2. **Apply vs. review (proposed):** CSV-detected returns are review-gated, not auto-applied, because multi-item orders can't always be attributed automatically.
3. **Edit semantics:** reverse-then-re-record (not in-place adjustment), matching the trade-edit pattern.
4. **Return shipping:** tracked as its own `shipping_postage` transaction, separate from `refund_amount`, because it's a different Schedule C line.
5. **Cardinality:** one active return per sale in v1.

## Success criteria

**Manual path (shipped — verify):**
- Record a partial return with a return-shipping cost; sale shows `partial`,
  inventory `quantity_remaining` increases by the returned qty at the original
  `unit_cost`, Net Payout drops (red if negative), and two transactions appear:
  `returns_allowances` (−refund) and `shipping_postage` (−label).
- Dashboard Schedule C breakdown shows the refund as a negative Part I line and
  the return label under Part II shipping — gross receipts are *not* silently
  netted.
- Edit that return to a smaller qty; inventory + refund totals reconcile to the
  new values with no orphaned movements or transactions.
- Full return excludes the sale from revenue/profit aggregates and hides the
  Process Return button.
- Hand-tally of a sample period with a return matches `computeScheduleC`.

**CSV layer (proposed — acceptance when built):**
- Importing an eBay report containing a refund + return label for an already-synced
  order surfaces one review-queue candidate; confirming it restores inventory and
  re-tags the two existing CSV transactions (no duplicate refund/shipping rows).
- Re-importing the same report applies nothing new (idempotent).
- A refund for an unmatched order stays in the queue rather than corrupting a
  wrong sale.
