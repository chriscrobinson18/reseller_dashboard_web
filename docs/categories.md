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

## Known correctness gaps (see TASKS.md P0/P1 for full detail — don't fix ad-hoc, read that list first)

- Custom categories (planned, stored per-user in Supabase rather than this static array) must flow into the dashboard render layer once they ship — see [Custom categories (planned — P1)](#custom-categories-planned--p1) below. `bucketTransaction` itself is already category-string-agnostic.
- Negative payout rows (returns) net into Part I gross revenue today because no UI ships refunds via `returns_allowances` yet. Once the P1 return UI lands, the dashboard's Part I render must visually subtract Returns & Allowances from Gross Receipts (1099-K mismatch risk).

## Custom categories (planned — P1)

When the `custom_categories` table ships (user_id, name, scheduleLine, mealsHalf, isExcluded), `bucketTransaction` in `src/lib/categories.ts` already handles arbitrary `schedule_c_category` strings — it doesn't depend on `CATEGORIES`. The work is in the **display layer**:

- `DashboardPage.tsx` Part I / Part II / Part III row builders currently do `CATEGORIES.filter(...)`. They must merge `CATEGORIES` with the user's custom categories at render time (e.g., via a `useCustomCategories()` React Query hook).
- `bucketTransaction`'s `scheduleLine` check must also pick up custom-category metadata; the cleanest approach is to inject custom categories into a combined `categories: CategoryDef[]` list and have `getCategoryDef` look in both.

P0 item 3 calls this out specifically: if you ship `custom_categories` without updating the Schedule C breakdown render, all custom-categorized transactions silently disappear from the breakdown.

## Returns & Allowances (added 2026-06-23)

`returns_allowances` (Part I, displayed as a subtraction from Line 1 Gross Receipts on the IRS form) is in `CATEGORIES`. The `record_return` edge function (v21, deployed 2026-06-23) inserts a refund `transactions` row with `schedule_c_category: 'returns_allowances'` and `amount: -refund_amount` for every return. The dashboard's `bucketTransaction` routes those rows into the income bucket with a negative signed amount, so they already reduce Part I totals through the math.

P0 item 4 (display-layer follow-up, still pending until the P1 refund UI ships): the dashboard's Part I render must visually show `returns_allowances` as a separate subtraction line below Gross Receipts (e.g., "Gross Receipts $X − Returns & Allowances $Y = Line 1 $Z"), not silently net into the `payout` total. This matters for 1099-K reconciliation: a 1099-K reports gross receipts, and our Line 1 must match before we subtract returns. Inline `TODO(p1-returns)` markers in `DashboardPage.tsx` flag the exact render sites.
