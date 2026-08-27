# Cross-cutting business logic

These rules are duplicated across multiple pages/functions rather than centralized — when you change one, grep for the others (each function below names its known siblings).

## "Is this transaction real business income/expense?" — `bucketTransaction`

Centralized in [`src/lib/categories.ts`](../src/lib/categories.ts) as `bucketTransaction(t): { bucket, categoryValue, signedAmount }` (added 2026-06-23, P0 item 1). All three dashboard aggregates (`computeKPIs`, `computeMonthlyChart`, `computeScheduleC`) go through it. `ExpensesPage.tsx` still does its own inline `uncategorized` count and `showSaleLinked` filter.

Rules — first match wins, anything that returns `bucket: null` is excluded:

| Condition | Bucket |
|---|---|
| `record_type === 'settlement'` | `null` |
| `related_sale_id` set | `null` |
| `source === 'csv_import'` | `null` |
| `net_zero_pair_id` set | `null` |
| `schedule_c_category` null/undefined | `null` |
| Category `isExcluded === true` | `null` |
| `scheduleLine === 'Part I'` | `'income'` |
| `scheduleLine === 'Part III'` | `'cogs'` |
| Otherwise (Part II) | `'expense'` (×0.5 if `mealsHalf`) |

**Why `related_sale_id` / `csv_import` are excluded**: a sale's revenue/fees/shipping are already counted via `computeProfitability(sales)`. The payout/fee/shipping `transactions` rows that `recordSale` auto-creates (see below) exist so Expenses shows them, but a Dashboard aggregate that summed both the sale and its linked transactions would double-count.

**Signed-amount semantics:** `bucketTransaction` returns `signedAmount` preserving the original sign (with the meals 0.5 multiplier already applied for the expense bucket). Consumers sum signed amounts per bucket/category, take `abs()` only at display time. A refund posted to an expense category now correctly *reduces* that expense total instead of inflating both income and expenses (the pre-2026-06-23 bug). See [categories.md](categories.md#buckettransaction--single-bucketing-helper) for the full description.

## Recording a sale (`recordSale` in `mutations.ts`)

1. Calls the `record_sale` edge function → inserts the `sales` row, FIFO-depletes `inventory_lots.quantity_remaining` oldest-lot-first, writes `inventory_movements` audit rows. Returns `sale_id`, `inventory_status` (`ok`/`oversold`/`reconciled`), `unfulfilled_quantity`.
2. If `fees`/`shippingCost` were passed, the client computes `net_payout = sale_price - fees - shipping_cost` and `.update()`s the `sales` row directly — **this is client-computed, not server-computed**. `updateSale` later recomputes the same way on edit.
3. Calls `createSaleTransactions` → inserts up to 3 `transactions` rows, all tagged `related_sale_id: saleId`, `source: 'manual'`:
   - payout row: `amount: +salePrice`, category `payout`
   - fee row (if `fees > 0`): `amount: -fees`, category `commissions_fees`
   - shipping row (if `shippingCost > 0`): `amount: -shippingCost`, category `shipping_postage`

This is why a single "sale" shows up as one row in Sales but up to three rows in Expenses (visible there only when the "Sale rows" filter toggle is on).

**Exception:** the "all tagged `related_sale_id`" rule above holds only for an ordinary sale. A bundle line's payout/fee/shipping rows are tagged `related_bundle_id` instead — see the next section.

## Recording a bundle sale (`recordBundleSale` in `mutations.ts`)

One order, several **different** items, one combined payout — a multi-item marketplace order, or an in-person mixed lot. Entered from the same `RecordSaleModal` as an ordinary sale: adding a second item row is what turns it into a bundle (see [`features/sales.md`](features/sales.md#bundle-sales-multi-item-orders) for the UI).

1. Inserts one `sale_bundles` header row (date, platform, payment method, order id, **order-level** fees/shipping, notes).
2. For each item, calls `record_sale` directly — same FIFO depletion, same `inventory_movements`, same per-item `sale_price` as an ordinary sale. Each resulting `sales` row is stamped `bundle_id = <bundle id>`, `fees: 0`, `shipping_cost: null`, `net_payout: <that line's own price>` (mirrors what `recordTrade` does for given-side sales — see below).
3. Creates **exactly one** payout/fee/shipping transaction set for the whole order, tagged `related_bundle_id` (not `related_sale_id` — no single line owns an order-level fee).

**Why not just call `recordSale()` N times:** that would run step 3's transaction-creation logic once per line, multiplying the real order payout by the number of items. The one-`sale_bundles`-header-plus-N-plain-`sales`-rows shape mirrors `trades` (below) rather than restructuring `sales` into a header/line-item table — FIFO depletion, returns, and `reverse_sale` all keep working on bundle lines completely unmodified.

**Order-level fees/shipping are allocated back at read time.** Storing `fees: 0` on each line keeps the write side honest (the real charge exists once, on the bundle) but makes every line *look* free to sell. `fetchSales` therefore splits the bundle's fees and shipping across its lines **proportionally by line price** — a $100 line in a $200 order bears half — writing them to the client-only `allocated_fees` / `allocated_shipping` fields. `saleProfit()` prefers those over the row's zeroed `fees`/`shipping_cost`; without this, every bundle line overstates profit by its share of both.

These stay separate from `fees`/`shipping_cost` rather than overwriting them, because `EditSaleModal` seeds its form from those columns — overwriting would persist an allocated share onto the line the first time anyone edited it. The same allocation drives the Sales list's **Net** column: a bundle's transactions carry `related_bundle_id`, so the `related_sale_id` lookup finds nothing and would otherwise fall back to the gross line price.

**Deleting a bundle** (`deleteBundleSale`) reverses each line via `reverse_sale` (restores inventory, soft-deletes the line), deletes the bundle's own transactions, and soft-deletes the `sale_bundles` row. No downstream-depletion check is needed first, unlike `deleteTrade` — a bundle sale only depletes inventory, it never creates lots.

**Editing a bundle sale** (`updateBundleSale`) updates the `sale_bundles` row, re-stamps date/platform/payment method/order id onto every line (mirroring the stamp step 2 above already does at creation), and updates each line's own `quantity`/`sale_price`/`net_payout` — but never `fees`/`shipping_cost`, which stay `0`/`null` on every line just as at creation. It then syncs the bundle's linked transactions by `related_bundle_id` + `schedule_c_category`: the payout row is always updated (it always exists), but the fee/shipping rows are **created** if a positive value now exists and none did before, **updated** if one already exists, and **deleted** if edited down to zero/cleared. This is unlike `updateSale`, which only ever touches transaction rows that already exist — a bundle can be recorded with no fee at all and have one added later, so there's often nothing yet to update. Without creating the row, `BundleDetailSlideOver`'s Schedule C card (which reads actual `transactions`, not `sale_bundles.fees`/`shipping_cost`) would show nothing even though the bundle row and every line's allocated share already reflect the new amount. Line **item** is never editable through this path; changing it would mean reversing that line's FIFO depletion and re-depleting a different item's lots, a different shape of change than a field edit.

## Editing a sale (`updateSale`)

Updates the `sales` row, recomputes `net_payout`. **Only for `source === 'manual'` sales**, it then re-fetches the linked transaction rows (`related_sale_id = id AND source = 'manual'`) and patches each one's `amount`/`date` to match, keyed by `schedule_c_category` (`payout` → sale price, `commissions_fees` → fees, `shipping_postage` → shipping). CSV-imported or Plaid-derived sales have no linked manual transactions to sync — editing those only touches the `sales` row.

## Deleting a sale (`deleteSale`)

Invokes the `reverse_sale` edge function (committed at [`supabase/functions/reverse_sale/`](../supabase/functions/reverse_sale/)), which in turn calls the `public.reverse_sale(uuid)` Postgres RPC. The RPC runs all four steps in a single transaction with `FOR UPDATE` locks on the affected lot rows:

1. Restore `quantity_remaining` on every lot the sale depleted (driven by `inventory_movements` rows for the sale).
2. Delete those `inventory_movements` rows.
3. Delete the linked manual `transactions` rows (`related_sale_id = id AND source = 'manual'`).
4. Soft-delete the `sales` row (`deleted_at = now()`).

Replay protection: a second call on an already soft-deleted sale raises `already_deleted` (→ HTTP 409 from the edge function), so client retries don't double-restore stock. Ownership: the RPC raises `forbidden` (→ 403) if `auth.uid()` doesn't match `sales.user_id`. Don't copy this directly into a different "undo" flow without re-thinking the lock scope — `record_sale` reads lot quantities before writing them, so anything new touching the same lots needs to participate in the same locking order to avoid races.

## FIFO COGS computation

COGS for a sale = `sum(inventory_movements.quantity * inventory_movements.inventory_lots.unit_cost)` for that sale.

[`src/lib/saleProfit.ts`](../src/lib/saleProfit.ts) (added 2026-06-23) is the shared helper that computes COGS, return-adjusted `netRevenue`, and `profit`. Used by `SalesPage.SaleDetail`. The remaining duplicates:

- `DashboardPage.computeProfitability` still inlines the same COGS sum + return-adjustment because it aggregates across many sales rather than calling `saleProfit` per row — if you change the formula, update both call sites or refactor `computeProfitability` to call `saleProfit` per sale.
- `TransactionInventorySection` on the Expenses side does the per-lot multiplication implicitly (lot-by-lot) and doesn't need `saleProfit`.

`unit_cost` is the lot's **all-in basis**, not just what was paid at purchase — see "Capitalizing a cost into a lot" below. COGS therefore picks up grading and shipping-to-grader fees automatically, with no change to this formula.

`itemAvgCost` in `queries.ts` computes a **weighted-average** unit cost across an item's lots — this is for display only (Inventory page "Avg Cost" column); actual COGS accounting is always FIFO via `inventory_movements`, never the average.

## Capitalizing a cost into a lot (`addLotCostAdjustment` in `mutations.ts`)

Costs incurred *after* purchase that still belong to an item's cost: grading a card, shipping it to the grader. Entered from the receipt icon on any Inventory lot row.

1. Resolve the deduction — **create** a `cost_of_goods` transaction (`amount: -amount`, `date: incurredOn`), or **link** one that already exists (a Plaid-synced grader charge). Never both; posting a row for an already-synced payment would deduct it twice. The choice is recorded on `lot_cost_adjustments.created_transaction`.
2. Insert the `lot_cost_adjustments` row.
3. Recompute the lot's `unit_cost` from the invariant and write it back:

```
unit_cost = (initial_unit_cost × quantity_purchased + Σ active adjustments) / quantity_purchased
```

Step 3 always rebuilds from `initial_unit_cost` and the *full* adjustment set rather than adding a delta — that's what keeps add/remove cycles from drifting. `basisFromAdjustments()` in [`src/lib/lotCost.ts`](../src/lib/lotCost.ts) does it in integer cents and is unit-tested, including a no-drift property test.

**Removing one** (`deleteLotCostAdjustment`) soft-deletes the row, recomputes the basis back down, and deletes the linked transaction **only if this adjustment created it** — a linked bank row is real history and survives. **Deleting the lot** cascades a soft-delete to its adjustments but keeps every transaction: the fee was genuinely paid, so the deduction stands (same reasoning as `deleteSale`).

**Why this and not sale-level COGS.** An earlier iteration let a *sale* consume lots of several items. It worked, but a grading fee isn't a property of the sale — it's a property of the card, incurred long before any sale exists and true regardless of how (or whether) the card is eventually sold. Modeling it at the lot means the basis is right the moment the fee is paid. That approach was reverted; see `20260726130000_drop_sale_cost_components.sql`.

## Opening a box (UI: "Breakdown Inventory"; `openBox` in `mutations.ts`)

See [`docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md`](superpowers/specs/2026-06-23-box-opening-and-grading-design.md) for the full accounting rationale and the 2026-08-03 revision note below. Summary:

The box being opened is **already an inventory lot** — bought and entered the normal way (Add Item + Add Lot), linked and categorized `cost_of_goods` at purchase time like everything else. So its cost is already on Schedule C by the time it's opened, and opening it must not post a second deduction. `openBox` takes a `sourceLotId` + `quantity` (not a typed name/cost), and creates:
- **No transaction.** Nothing to deduct — it's already deducted.
- 1 `box_openings` audit row (`source_lot_id`, `quantity`, `box_cost = sourceLot.unit_cost × quantity`, `transaction_id` mirroring the source lot's for display only — may be `null`)
- N `inventory_lots` rows, one per card (`quantity_purchased = 1`, `box_opening_id` set, `unit_cost` = that card's allocated share, `transaction_id` mirroring the source lot's)
- N `inventory_lot_transactions` rows mirroring the funding link, only when the source lot had one to mirror

It also **depletes the source lot**: `quantity_remaining -= quantity`, the same effect a sale would have, since the box units really are leaving inventory (as cards, not as a sale).

**Allocation is Profitability-only.** `allocateBoxCost()` (`src/lib/boxAllocation.ts`) splits `box_cost` across cards by relative FMV, equal share, or specific $ (user's choice, `box_openings.allocation_method`), always summing back to `box_cost` exactly (integer-cents, largest-remainder rounding). Since no new transaction is posted, the allocation choice never touches Schedule C at all — it only sets the per-card basis that the Profitability dashboard and per-sale profit use once a card sells.

FIFO depletion, `record_sale`, and returns need no changes: a box-opening card lot is structurally identical to a cash-purchased lot, just with `box_opening_id` populated.

**Deleting a box opening** (`deleteBoxOpening`) blocks if any resulting card has been sold (`quantity_remaining < quantity_purchased` — same guard shape as `deleteTrade`), otherwise soft-deletes the card lots (cascading to their own `lot_cost_adjustments`, same as `deleteLot`), **restores `quantity` back onto the source lot**, and soft-deletes the `box_openings` row. There's no transaction to reverse, unlike `deleteLotCostAdjustment` on a created transaction — opening never created one.

**2026-08-03 revision.** The first version of this flow assumed the box hadn't been recorded yet: it took a typed box name/cost and posted a fresh `cost_of_goods` transaction at open time (the NIMS "deduct when used" reading). Revised the same day, before the feature saw real use, once it was clear the common case is a box that's already been bought and entered into inventory like any other lot — in which case its cost was deducted at *purchase*, and posting a second transaction at *open* time would double-count it. The "pick a lot from inventory, deplete it" model above is what shipped.

## Revenue net of returns

`netRevenue = sale_price - (return_status === 'partial' ? refunded_amount : 0)`. Sales with `return_status === 'full'` are excluded entirely from revenue/profitability sums (`active = sales.filter(s => s.return_status !== 'full')`). Centralized in `saleProfit()` for per-sale callers; `DashboardPage.computeProfitability` and the `totalRevenue` calc in `SalesPage` still inline the same formula since they aggregate across many sales.

`record_return` (v21, local source ahead as v2 — see the CSV note below) also posts a refund `transactions` row (`schedule_c_category: 'returns_allowances'`, `amount: -refund_amount`) and, when a return-shipping cost is given, a second `shipping_postage` row — **both carry `related_sale_id`**. Because `bucketTransaction` drops every `related_sale_id` row, these refund rows do **not** appear in the Dashboard's transaction-derived aggregates (KPIs / Schedule C breakdown / monthly chart). Returns reach those numbers only through the Sales Profitability card's `netRevenue` (partial-return refund subtracted, full returns excluded). The refund + return-shipping rows *do* surface in the Schedule C **CSV export**, which deliberately includes sale-linked rows — there the payout row (gross `sale_price`) and the `returns_allowances` row net correctly for 1099-K-style "gross receipts − returns" reporting. See [categories.md](categories.md#returns--allowances-added-2026-06-23). (A manually-categorized `returns_allowances` transaction with **no** `related_sale_id` is different: it is not sale-linked, so `bucketTransaction` includes it in the Part I bucket with a negative signed amount.)

**CSV-reconciled returns (2026-08-27; not yet deployed — see `docs/supabase-schema.md`).** When a return is applied through the Return Reconciliation review queue (`docs/features/settings.md#return-reconciliation`) instead of the manual `ProcessReturnModal`, `record_return` **re-tags** the real imported CSV refund/shipping transaction rows in place — `related_sale_id` + `schedule_c_category` flip on the *existing* row — rather than inserting new synthetic ones. The Dashboard/CSV-export accounting above is unaffected either way: both paths end with the same `related_sale_id`-carrying rows in the same categories, so `bucketTransaction`'s exclusion and the CSV export's inclusion behave identically regardless of which path produced the row. The only difference is the row's `date`/`amount` are the real imported values rather than "today" + a typed estimate, and the same real transaction row is never duplicated.

## Net payout on the Sales page

`SalesPage.fetchSales` additionally fetches every `transactions` row with `related_sale_id in (visible sale ids)` and sums `amount` per sale into `netPayoutBySale`. `netPayoutFor(sale)` returns that sum — so Net Payout reflects **all** linked rows (payout + fees + outbound shipping + refund + return shipping), and a return whose label cost exceeds its refund shows as a **negative** payout (rendered red). Falls back to `sale.net_payout` (then `sale_price − fees`) for sales with no linked transactions (e.g. CSV-imported sales).

## Recording a trade (`recordTrade` in `mutations.ts`)

See [`docs/superpowers/specs/2026-06-23-trades-design.md`](superpowers/specs/2026-06-23-trades-design.md) for the full accounting rationale. Summary:

A barter trade creates:
- 1 `trades` row
- N given-side `sales` rows (FIFO-depletes inventory via the `record_sale` edge function; no `createSaleTransactions` call — income is covered by the trade's bundled income transaction)
- M `inventory_lots` rows for received-side items (basis = allocated FMV per line)
- 2 non-cash `transactions` rows (income + COGS, always a wash; `is_non_cash = true`)
- 0 or 1 cash boot `transaction` row (`is_non_cash = false`; only when `cash_boot ≠ 0`)

### Canonical Schedule C rule

For a trade with `given_FMV`, `received_FMV`, and signed `cash_boot` (positive = you received cash, negative = you paid cash):

| Component | Amount | `is_non_cash` |
|---|---|---|
| Non-cash income | `given_FMV − max(boot_received, 0)` | `true` |
| Non-cash COGS | same as non-cash income (always a wash) | `true` |
| Cash boot | `cash_boot` (signed; absent if 0) | `false` |

The two non-cash legs always wash each other. **The cash boot leg carries the entire Schedule C impact of the trade event.** If there's no boot, the trade is Schedule-C-neutral at the time it happens; economic gain materializes later when received lots are sold.

### Worked examples

All examples assume the given item was previously bought for $2,000 (already deducted as `cost_of_goods` at purchase).

**Pure swap.** Give 1 box (FMV $3,000); receive 10 boxes (FMV $3,000); no cash. (`given_FMV == received_FMV` — the trade sets both.)
- Non-cash income: +$3,000 (`payout`, `is_non_cash = true`)
- Non-cash COGS: −$3,000 (`cost_of_goods`, `is_non_cash = true`)
- Cash boot: none
- Net Schedule C from trade: **$0**
- New lots: 10 lots totaling $3,000 basis
- Future $5,000 sale of received boxes: +$5,000 revenue, no COGS. Total chain profit: $5,000 − $2,000 = $3,000. ✓

**Paid boot.** Give 1 box (FMV $2,500); receive 10 boxes (FMV $3,000); pay $500 cash.
- Non-cash income: +$2,500 (`payout`, `is_non_cash = true`)
- Non-cash COGS: −$2,500 (`cost_of_goods`, `is_non_cash = true`)
- Cash boot: −$500 (`cost_of_goods`, `is_non_cash = false` — normal bank txn)
- Net Schedule C from trade: **−$500**
- New lots: 10 lots totaling $3,000 basis ($2,500 non-cash + $500 cash)
- Future $5,000 sale: total chain profit: $5,000 − $2,000 − $500 = $2,500. ✓

**Received boot.** Give 1 box (FMV $3,000); receive 10 boxes (FMV $2,500) + $500 cash.
- Non-cash income: +$2,500 (`payout`, `is_non_cash = true`)
- Non-cash COGS: −$2,500 (`cost_of_goods`, `is_non_cash = true`)
- Cash boot: +$500 (`payout`, `is_non_cash = false` — normal bank txn)
- Net Schedule C from trade: **+$500**
- New lots: 10 lots totaling $2,500 basis (no cash portion — cash was received, not paid)
- Future $5,000 sale: total chain profit: $5,000 − $2,000 + $500 = $3,500. ✓

### Profitability dashboard

The Dashboard's Profitability card reads from `inventory_movements.unit_cost` (set when trade-acquired lots are later sold via `record_sale`). No special-casing is needed — trade-acquired lots behave identically to cash-purchased lots for future sales.

### Deleting a trade (`deleteTrade`)

`deleteTrade` hard-deletes the three transactions (income, COGS, cash boot if any), then calls the existing `reverse_sale` RPC for each given-side sale (atomically restores depleted lots), then soft-deletes the given-side sales and received-side lots. Aborts if any received lot has been partially or fully depleted (preventing orphaned inventory movements). **Known v1 limitation:** FIFO reversal on the given-side sales inherits the same gap as `deleteSale` — if the underlying lots were themselves depleted by other sales since the trade, the restoration is incomplete. See TASKS.md "Trades v2 follow-ups."

## Period filtering

`getPeriodRange(preset)` in `periods.ts` returns `{ start, end }` as `'yyyy-MM-dd'` strings (or `{ null, null }` for `all_time`). Every page passes this into its own fetch function as `.gte('date'|'sold_at', start)` / `.lte(..., end)`. Transactions filter on `date`; sales filter on `sold_at` with `'T00:00:00Z'`/`'T23:59:59Z'` suffixes appended (since `sold_at` is a full timestamp, not just a date).
