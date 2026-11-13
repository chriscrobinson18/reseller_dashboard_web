# Schedule C categories

Defined in [`src/lib/categories.ts`](../src/lib/categories.ts) as `CATEGORIES: CategoryDef[]`, ported from the iOS app (`src/lib/categories.ts` there) so both clients categorize identically. Looked up everywhere via `getCategoryDef(value)`.

```ts
interface CategoryDef {
  value: string          // stored in transactions.schedule_c_category
  label: string          // display name
  color: string; bgColor: string
  isExcluded: boolean    // true = NOT business income/expense, excluded from every Schedule C total
  mealsHalf?: boolean     // true only for 'meals' — IRS 50% deductibility
  scheduleLine?: string  // 'Part I' | 'Part III' | 'Line N' (Part II) — drives Dashboard grouping
}
```

## The categories

| value | label | scheduleLine | isExcluded | mealsHalf |
|---|---|---|---|---|
| `transfer` | Transfer | — | ✅ | |
| `personal` | Personal | — | ✅ | |
| `settlement` | Settlement | — | ✅ | |
| `balance_adjustment` | Balance Adjustment | — | ✅ | |
| `payout` | Payout / Income | Part I | | |
| `returns_allowances` | Returns & Allowances | Part I | | |
| `cost_of_goods` | Cost of Goods | Part III | | |
| `advertising` | Advertising | Line 8 | | |
| `car_truck` | Car & Truck | Line 9 | | |
| `commissions_fees` | Commissions & Fees | Line 10 | | |
| `contract_labor` | Contract Labor | Line 11 | | |
| `depreciation` | Depreciation | Line 13 | | |
| `insurance` | Insurance | Line 15 | | |
| `interest_expense` | Interest Expense | Line 16 | | |
| `legal_professional` | Legal & Professional | Line 17 | | |
| `office_expense` | Office Expense | Line 18 | | |
| `rent_lease` | Rent or Lease | Line 20b | | |
| `repairs_maintenance` | Repairs & Maint. | Line 21 | | |
| `supplies` | Supplies | Line 22 | | |
| `taxes_licenses` | Taxes & Licenses | Line 23 | | |
| `travel` | Travel | Line 24a | | |
| `meals` | Meals (50%) | Line 24b | | ✅ |
| `utilities` | Utilities | Line 25 | | |
| `shipping_postage` | Shipping & Postage | Line 27a | | |
| `other_expense` | Other Expense | Line 27a | | |
| `home_office` | Home Office | Line 30 | | |

## How the flags are used

- **`isExcluded`**: every aggregate function (Dashboard KPIs, monthly chart, Schedule C breakdown — see [data-flows.md](data-flows.md)) filters out transactions whose category has `isExcluded: true`, on top of also excluding settlements and sale-linked/CSV rows. This is the mechanism that keeps transfers/personal spend/internal settlements out of tax totals.
- **`mealsHalf`**: only `meals` has it. Every expense total multiplies by `0.5` when this flag is set, before taking `Math.abs()`. This is the *only* per-category math rule beyond inclusion/exclusion — if you add a category with special tax treatment (e.g. a future depreciation schedule), this is the pattern to extend, not a one-off `if (category === 'x')` somewhere else.
- **`scheduleLine`**: purely a grouping/display key for the Dashboard's Schedule C breakdown (`partI`/`partII`/`partIII` filters in `DashboardPage.tsx`). Anything without a `scheduleLine` (the four `isExcluded` categories) never appears in that breakdown.

## `bucketTransaction` — single bucketing helper

Added 2026-06-23 (P0 item 1). All three dashboard aggregates (`computeKPIs`, `computeMonthlyChart`, `computeScheduleC`) route every transaction through `bucketTransaction(t)` instead of branching on `t.amount > 0`. Returns:

```ts
{ bucket: 'income' | 'expense' | 'cogs' | null,
  categoryValue: string | null,
  signedAmount: number }   // sign preserved; meals × 0.5 already applied
```

Bucketing rules (in order — first match wins):

| Condition | Result |
|---|---|
| `record_type === 'settlement'` | `null` |
| `related_sale_id` set | `null` (sale-side handled by Profitability) |
| `source === 'csv_import'` | `null` (same rationale) |
| `net_zero_pair_id` set | `null` (cancels out) |
| `schedule_c_category` null/undefined | `null` (uncategorized) |
| Category `isExcluded === true` | `null` |
| `scheduleLine === 'Part I'` | `'income'`, signed `amount` |
| `scheduleLine === 'Part III'` | `'cogs'`, signed `amount` |
| Otherwise (Part II) | `'expense'`, signed `amount * (mealsHalf ? 0.5 : 1)` |

**Why signed:** a $50 refund posted to `supplies` arrives as `amount: +50`. Pre-fix this was bucketed as income and Math.abs'd back into expenses, inflating both. Now it lands as `{ bucket: 'expense', signedAmount: +50 }`, sums against the supplies expense total to reduce it, and the display layer takes `abs()` only at render. Same idea for refunds against income.

## Non-cash trade transactions

`payout` and `cost_of_goods` totals in the Schedule C breakdown **may include non-cash transactions from trades** (`transactions.is_non_cash = true`). Both legs are still correct Schedule C inputs — barter income is taxable at FMV (IRC § 1001), and the matching COGS deduction is legitimate. The non-cash pair always washes, so the only net Schedule C impact from a trade event is the cash boot leg (if any), which is a normal cash transaction (`is_non_cash = false`).

The `is_non_cash` flag exists so a future bank-reconciliation or cash-flow view can filter to `is_non_cash = false` rows only. `bucketTransaction` does **not** filter on this flag — both cash and non-cash transactions flow through the same bucketing logic and land in the same Schedule C totals, which is correct.

## Known correctness gaps (see TASKS.md P0/P1 for full detail — don't fix ad-hoc, read that list first)

- ~~The Dashboard's Schedule C breakdown and KPI cards are transaction-derived and miss sale income.~~ **Fixed 2026-11-09** by sales-based income (next section): the Breakdown, KPIs, chart and both CSV exports now include every recorded sale.

## Sales-based income (2026-11-09)

**Schedule C income comes from the Sales tab, not from bank deposits or transaction rows.** Owner decision, recorded in TASKS.md "Books Cleanup". Single source: [`src/lib/salesIncome.ts`](../src/lib/salesIncome.ts).

| Line | From each non-deleted `sales` row (period by `sold_at`) |
|---|---|
| Line 1 gross receipts | `sale_price + shipping_charged` (buyer-paid shipping is income; eBay's gross already includes it, TCGplayer reports it separately) |
| Line 2 returns | `refunded_amount`. A fully returned sale stays in Line 1 with its refund on Line 2 (1099-K presentation), netting to zero |
| Line 10 fees | `fees` (eBay: every Order Earnings fee column, incl. promoted-listing fees) |
| Line 27a shipping | `shipping_cost` = postage the **platform deducted**. Postage bought on a card (e.g. a label service) is a separate bank transaction, categorized as usual |

Bundles add their order-level `sale_bundles.fees` / `shipping_cost` once (lines store 0). Trades count at the recorded fair-market sale price.

**No double counting:** `isSaleDerivedTransaction(t)` (in `categories.ts`) marks the transactions that duplicate a sale's money: `related_sale_id` (Record Sale's payout/fee/shipping/refund rows), `related_bundle_id` (bundle rows) and `source = 'csv_import'` (marketplace report rows). `bucketTransaction` and both CSV exports skip them; they remain visible in Expenses as audit detail. Marketplace bank deposits are `settlement` rows (excluded); they serve as the completeness check (year-end tie-out), not income.

**One exception: eBay store subscription (owner decision 2026-11-13).** eBay Transaction Report rows that are `commissions_fees`, have no order number and read "Store (…): Subscription Fee …" (`isEbayStoreSubscriptionRow`) **do** count on Line 10: eBay takes the fee from the seller balance before paying out, so it is in neither Order Earnings nor the bank feed and the report row is its only record. This replaced 16 manual rows (2025 $107.16, 2026 $327.69) with identical Line 10 totals. Deliberately narrow — no other report row without an order number counts; instead the Year-End Tie-Out lists any such row that reaches the books by no path as a **ghost** (see [features/dashboard.md](features/dashboard.md)). eBay's charges to a card/bank to cover a negative balance ("Charge for …") are `settlement` rows on the card/bank side, not expenses.

**What still counts from transactions:** every other categorized business row. That includes bank deposits still tagged `payout` (P2P / auction / wallet deposits whose sales aren't recorded yet): the Phase 2 backlog, kept as income until classified so nothing disappears.

**Wiring:** `computeScheduleC` / `computeKPIs` / `computeMonthlyChart` take optional `SalesIncomeTotals` (merged into `payout`, `returns_allowances`, `commissions_fees`, `shipping_postage`); `computeScheduleCSummary` and `scheduleCExportRows` take the sales (and bundles). Without the optional argument they behave as before, which keeps older callers and tests valid. Net-zero pairs are excluded from the exports too (previously only the Dashboard excluded them).

## Custom categories (shipped 2026-06-25)

Stored in the `custom_categories` table (see [`docs/supabase-schema.md`](supabase-schema.md)). Two modes, mutually exclusive (CHECK constraint at the DB):

- **`parent_value`** set: the custom is a refinement of a built-in. It inherits `scheduleLine` / `mealsHalf` / `isExcluded` from the parent. E.g. `"Stripe Fees"` with `parent_value = 'commissions_fees'` lands in Line 10.
- **`schedule_line`** set: the custom maps directly to a Schedule C line (`'Part I' | 'Part III' | 'Line 8'…'Line 30'`, **excluding `'Line 24b'`** — Line 24b requires the 50% meals deduction, which is only inherited via `parent_value = 'meals'`).

Resolution lives in [`resolveCategory(value, customs)`](../src/lib/categories.ts) in `src/lib/categories.ts`. All code paths that touch real transaction data (`bucketTransaction`, the Dashboard `partI`/`partII`/`partIII` filter builders, `CategoryBadge`) call `resolveCategory` instead of `getCategoryDef`. `getCategoryDef` is kept for pure-built-in picker swatch loops.

**Soft delete:** deleting a custom sets `deleted_at`. Historical transactions referencing the tombstone keep working — `resolveCategory` still returns the resolved def with `" (deleted)"` appended to the label. Pickers filter `!deletedAt` via `activeCustomCategories()`. Restoring deleted customs from a "Recently deleted" view is a v2 follow-up.

**On-the-wire value:** `transactions.schedule_c_category` stores `cust_<uuid-no-hyphens>` for custom rows. The `cust_` prefix avoids collision with future built-in slugs.

**Management UI:** [`ManageCategoriesModal`](../src/components/modals/ManageCategoriesModal.tsx), reachable via the "⚙ Manage categories…" footer in every category-picker dropdown (Expenses filter, Expenses inline category cell, transaction detail-pane category, AddTransactionModal). No dedicated Settings page. The modal carries an in-header `InfoPopover` (`(i)` icon) that explains the two mapping modes, tombstone behavior, and the Line 24b workaround — matches the trades modal help pattern.

**Friendly Schedule C line labels:** raw line identifiers (`'Line 18'`, `'Part I'`, etc.) aren't meaningful to a user picking a destination. `describeScheduleLine(line)` in [`src/lib/categories.ts`](../src/lib/categories.ts) maps each to a user-facing name (e.g. `'Office Expense (Line 18)'`, `'Income / Gross Receipts (Part I)'`, `'Other Expenses (Line 27a)'`). Most names are derived from the first matching `CATEGORIES[].label`; three lines that aggregate multiple built-ins (Part I, Part III, Line 27a) are special-cased so they read like the IRS form rather than the first-found category. Used by the explicit-line `<select>` in `ManageCategoriesModal` today; reuse here when other surfaces need friendly line labels.

## Returns & Allowances (added 2026-06-23; return UI shipped 2026-07-10)

`returns_allowances` (Part I, displayed as a subtraction from Line 1 Gross Receipts on the IRS form) is in `CATEGORIES`. The `record_return` edge function (v21) inserts a refund `transactions` row with `schedule_c_category: 'returns_allowances'` and `amount: -refund_amount` for every return, now driven by `ProcessReturnModal` (see [`docs/features/sales.md`](features/sales.md)) or, for a return detected in an imported CSV, by the Return Reconciliation review queue (`docs/features/settings.md#return-reconciliation`, not yet deployed) — which re-tags an existing `csv_import` row to this category instead of inserting a new one.

**Important — how the refund row actually flows.** `record_return` sets `related_sale_id` on the refund row, and `bucketTransaction` returns `none` for any `related_sale_id` row. So the refund is **excluded** from the Dashboard's transaction aggregates (`computeKPIs` / `computeScheduleC` / `computeMonthlyChart`) — it does **not** reduce the Part I breakdown "through the math." Returns instead reduce the Sales Profitability card via `netRevenue` (partial refunds subtracted, full returns excluded from the active set). The refund row *is* included in the Schedule C **CSV export** (`scheduleCExportRows` keeps sale-linked rows), where it nets against the gross payout row. Only a **manually-categorized** `returns_allowances` transaction (no `related_sale_id`) actually lands in the Part I bucket with a negative signed amount.

Still open (was P0 item 4): there is no unified on-screen Schedule C that shows `returns_allowances` as a separate subtraction line below Gross Receipts (e.g. "Gross Receipts $X − Returns & Allowances $Y = Line 1 $Z"). This matters for 1099-K reconciliation. The Schedule C **Summary export** (one row per IRS line) is the intended home for that presentation and is not yet built — see TASKS.md. Inline `TODO(p1-returns)` markers in `DashboardPage.tsx` flag the render sites; note their premise (refund rows reduce Part I via `bucketTransaction`) is superseded by the sale-linked exclusion described above.
