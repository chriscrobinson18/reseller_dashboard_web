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
| Sale-derived (`isSaleDerivedTransaction`): `related_sale_id` or `related_bundle_id` set, `source === 'csv_import'`, or a trade income leg (`trade_id` with amount > 0) | `null` — the `sales` row carries that money (next section). **Exception:** eBay store subscription report rows (`isEbayStoreSubscriptionRow`) are not sale-derived and count on Line 10 |
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

## Known correctness gaps

See TASKS.md "Code follow-ups" (Amazon refunds netted into Line 1; TCGplayer refunds not imported; return-shipping cost from in-app returns not reaching Line 27a). Don't fix money math ad hoc: read the related doc section first.

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

**One exception: eBay store subscription (owner decision 2026-11-13).** eBay Transaction Report rows that are `commissions_fees`, have no order number and read "Store (…): Subscription Fee …" (`isEbayStoreSubscriptionRow`) **do** count on Line 10: eBay takes the fee from the seller balance before paying out, so it is in neither Order Earnings nor the bank feed and the report row is its only record. It replaced manual rows entered earlier the same day, with identical Line 10 totals (verified on live data). Deliberately narrow — no other report row without an order number counts; instead the Year-End Tie-Out lists any such row that reaches the books by no path as a **ghost** (see [features/dashboard.md](features/dashboard.md)). eBay's charges to a card/bank to cover a negative balance ("Charge for …") are `settlement` rows on the card/bank side, not expenses.

**What still counts from transactions:** every other categorized business row (expenses, cost-of-goods purchases, manual refund rows for prior-year sales, the eBay store subscription). Bank deposits never do: since 2026-11-10 every deposit is `settlement`, `transfer` or `personal` ([books-cleanup-handoff.md](books-cleanup-handoff.md#decision-log)). A deliberately tagged `payout` row (rare non-sale business income, e.g. a platform bonus) still counts on Part I.

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

### Custom categories in use

Created during the 2025–26 books cleanup (owner decisions in [books-cleanup-handoff.md](books-cleanup-handoff.md#decision-log)), all mapped to Line 27a:

| Name | What goes in it |
|---|---|
| Software & Subscriptions | Sourcing bots, proxies, cook groups and similar reselling tools |
| Tech & Dev Tools | AI assistants, cloud hosting, bank-data API fees and design tools used to build and run the business's own software. Not named "R&D": §174 research-expense rules are a separate regime; these are ordinary subscriptions |
| Memberships | Warehouse-club and retailer memberships used for buying inventory. Membership refunds use the same category so they net. Merchants that sell both goods and memberships under one merchant ID get no auto-categorization rule |
| Credit Card Rewards | Card cash-back, as a reduction of expenses (the purchases that earned it were deducted). Same net effect as other income without mixing it into gross receipts |

Legacy iOS tags (`proxies`, `automation_software`, `cook_group`, `memberships`, `equipment`, `disbursement`) were re-tagged onto these or onto built-in lines on 2026-11-09.

## Returns & Allowances

`returns_allowances` is Part I; Schedule C shows it as **Line 2**, a subtraction from Line 1 gross receipts, never netted into Line 1 (1099-K guardrail).

- **Where Line 2 comes from:** each sale's `refunded_amount` (`src/lib/salesIncome.ts`). A fully returned sale stays on Line 1 with its refund on Line 2, netting to zero. `record_return` (manual `ProcessReturnModal`, or the CSV Return Reconciliation queue) sets `refunded_amount` / `return_status` on the sale.
- **The refund transaction rows** `record_return` posts or re-tags carry `related_sale_id`, so they are sale-derived and excluded from Schedule C (the sale already carries the refund). The CSV path re-tags the imported refund row instead of inserting one, so the money is never counted twice.
- **Refunds of prior-year sales** have no sale in the year; they are entered as manual `returns_allowances` rows, which count (see [reconciliation.md](reconciliation.md)).
- **Presentation:** the Schedule C Breakdown card and the Summary CSV (`buildScheduleCSummaryCSV`) both show Line 1 and Line 2 separately.
- **Known gap:** a seller-paid return-shipping cost entered in `ProcessReturnModal` is posted as a sale-linked `shipping_postage` row and so never reaches Line 27a (TASKS.md).
