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

## The 21 categories

| value | label | scheduleLine | isExcluded | mealsHalf |
|---|---|---|---|---|
| `transfer` | Transfer | — | ✅ | |
| `personal` | Personal | — | ✅ | |
| `settlement` | Settlement | — | ✅ | |
| `balance_adjustment` | Balance Adjustment | — | ✅ | |
| `payout` | Payout / Income | Part I | | |
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

- Negative payout rows (returns) net into Part I gross revenue today because no UI ships refunds via `returns_allowances` yet. Once the P1 return UI lands, the dashboard's Part I render must visually subtract Returns & Allowances from Gross Receipts (1099-K mismatch risk).

## Custom categories (shipped 2026-06-25)

Stored in the `custom_categories` table (see [`docs/supabase-schema.md`](supabase-schema.md)). Two modes, mutually exclusive (CHECK constraint at the DB):

- **`parent_value`** set: the custom is a refinement of a built-in. It inherits `scheduleLine` / `mealsHalf` / `isExcluded` from the parent. E.g. `"Stripe Fees"` with `parent_value = 'commissions_fees'` lands in Line 10.
- **`schedule_line`** set: the custom maps directly to a Schedule C line (`'Part I' | 'Part III' | 'Line 8'…'Line 30'`, **excluding `'Line 24b'`** — Line 24b requires the 50% meals deduction, which is only inherited via `parent_value = 'meals'`).

Resolution lives in [`resolveCategory(value, customs)`](../src/lib/categories.ts) in `src/lib/categories.ts`. All code paths that touch real transaction data (`bucketTransaction`, the Dashboard `partI`/`partII`/`partIII` filter builders, `CategoryBadge`) call `resolveCategory` instead of `getCategoryDef`. `getCategoryDef` is kept for pure-built-in picker swatch loops.

**Soft delete:** deleting a custom sets `deleted_at`. Historical transactions referencing the tombstone keep working — `resolveCategory` still returns the resolved def with `" (deleted)"` appended to the label. Pickers filter `!deletedAt` via `activeCustomCategories()`. Restoring deleted customs from a "Recently deleted" view is a v2 follow-up.

**On-the-wire value:** `transactions.schedule_c_category` stores `cust_<uuid-no-hyphens>` for custom rows. The `cust_` prefix avoids collision with future built-in slugs.

**Management UI:** [`ManageCategoriesModal`](../src/components/modals/ManageCategoriesModal.tsx), reachable via the "⚙ Manage categories…" footer in every category-picker dropdown (Expenses filter, Expenses inline category cell, transaction detail-pane category, AddTransactionModal). No dedicated Settings page. The modal carries an in-header `InfoPopover` (`(i)` icon) that explains the two mapping modes, tombstone behavior, and the Line 24b workaround — matches the trades modal help pattern.

**Friendly Schedule C line labels:** raw line identifiers (`'Line 18'`, `'Part I'`, etc.) aren't meaningful to a user picking a destination. `describeScheduleLine(line)` in [`src/lib/categories.ts`](../src/lib/categories.ts) maps each to a user-facing name (e.g. `'Office Expense (Line 18)'`, `'Income / Gross Receipts (Part I)'`, `'Other Expenses (Line 27a)'`). Most names are derived from the first matching `CATEGORIES[].label`; three lines that aggregate multiple built-ins (Part I, Part III, Line 27a) are special-cased so they read like the IRS form rather than the first-found category. Used by the explicit-line `<select>` in `ManageCategoriesModal` today; reuse here when other surfaces need friendly line labels.

## Returns & Allowances (added 2026-06-23)

`returns_allowances` (Part I, displayed as a subtraction from Line 1 Gross Receipts on the IRS form) is in `CATEGORIES`. The `record_return` edge function (v21, deployed 2026-06-23) inserts a refund `transactions` row with `schedule_c_category: 'returns_allowances'` and `amount: -refund_amount` for every return. The dashboard's `bucketTransaction` routes those rows into the income bucket with a negative signed amount, so they already reduce Part I totals through the math.

P0 item 4 (display-layer follow-up, still pending until the P1 refund UI ships): the dashboard's Part I render must visually show `returns_allowances` as a separate subtraction line below Gross Receipts (e.g., "Gross Receipts $X − Returns & Allowances $Y = Line 1 $Z"), not silently net into the `payout` total. This matters for 1099-K reconciliation: a 1099-K reports gross receipts, and our Line 1 must match before we subtract returns. Inline `TODO(p1-returns)` markers in `DashboardPage.tsx` flag the exact render sites.
