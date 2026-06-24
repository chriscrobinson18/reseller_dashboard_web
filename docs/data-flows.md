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

`itemAvgCost` in `queries.ts` computes a **weighted-average** unit cost across an item's lots — this is for display only (Inventory page "Avg Cost" column); actual COGS accounting is always FIFO via `inventory_movements`, never the average.

## Revenue net of returns

`netRevenue = sale_price - (return_status === 'partial' ? refunded_amount : 0)`. Sales with `return_status === 'full'` are excluded entirely from revenue/profitability sums (`active = sales.filter(s => s.return_status !== 'full')`). Centralized in `saleProfit()` for per-sale callers; `DashboardPage.computeProfitability` and the `totalRevenue` calc in `SalesPage` still inline the same formula since they aggregate across many sales.

Once the P1 refund UI ships, `record_return` (v21) also inserts a `transactions` row at `schedule_c_category: 'returns_allowances'` with `amount: -refund_amount`. Those rows land in the Part I bucket via `bucketTransaction`, so refunds reduce gross receipts in the Schedule C breakdown — see [categories.md](categories.md#returns--allowances-added-2026-06-23).

## Period filtering

`getPeriodRange(preset)` in `periods.ts` returns `{ start, end }` as `'yyyy-MM-dd'` strings (or `{ null, null }` for `all_time`). Every page passes this into its own fetch function as `.gte('date'|'sold_at', start)` / `.lte(..., end)`. Transactions filter on `date`; sales filter on `sold_at` with `'T00:00:00Z'`/`'T23:59:59Z'` suffixes appended (since `sold_at` is a full timestamp, not just a date).
