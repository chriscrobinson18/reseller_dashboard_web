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

## Known correctness gaps (see TASKS.md P0 for full detail — don't fix ad-hoc, read that list first)

- `computeScheduleC` currently sums `Math.abs(amount) * mult` per category — refunds/credits in an expense category should *reduce* the category total, not add to it. Should sum signed amounts and `abs()` only at display time.
- Custom categories (planned, stored per-user in Supabase rather than this static array) must flow into `computeScheduleC`, not just `CATEGORIES.find(...)`, once they ship.
- Negative payout rows (returns) currently net silently into Part I gross revenue instead of a separate "Returns & Allowances" bucket — 1099-K mismatch risk.
