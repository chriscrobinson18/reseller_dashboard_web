# P0 Tax-Correctness Pass — Design

**Date:** 2026-06-23
**Source:** `TASKS.md` § "P0 — Tax Correctness (port fixes, don't port the bugs)"
**Status:** Approved, ready for implementation plan

## Goal

Close the eight P0 items in `TASKS.md` so the web client's tax math is correct from day one, fix the matching bugs in the shared edge functions, lay down design guardrails for upcoming P1 features that would otherwise reintroduce the same bugs, and stand up a test framework so future regressions are caught automatically.

This is the first "real" engineering pass on the web codebase — it sets the patterns (shared computation helpers, edge-function source in repo, Vitest + Deno test infrastructure) that the rest of the porting work in `TASKS.md` will lean on.

## Scope

In:

- All eight P0 items from `TASKS.md`.
- Forward-looking design notes for items 2/3/4 (Part III scope, custom categories in Schedule C, Returns & Allowances bucket) so the upcoming P1 features can't reintroduce the same bugs.
- Test infrastructure (Vitest + Deno tests via local Supabase) covering every fix.
- Versioning the three edge functions touched by this pass (`record_sale`, `record_return`, new `reverse_sale`) under `supabase/functions/`.

Out:

- Snapshot-committing edge functions *before* fixing them — single combined commit per function is fine.
- Versioning edge functions we don't touch this pass (`import_marketplace_csv`, Plaid functions). Those land when their P1 features ship.
- Building any P1 feature itself (`record_return` UI, custom categories table, Beginning/Ending Inventory card). This pass only adds guardrails for them.

## Decisions (recap)

| Topic | Decision |
|---|---|
| `deleteSale` FIFO reversal | New `reverse_sale` edge function (atomic server-side) |
| Sign-handling fix sites | All three (`computeKPIs`, `computeMonthlyChart`, `computeScheduleC`) plus extract a shared `bucketTransaction` helper in `src/lib/categories.ts` |
| Edge function source | Pull → fix → deploy → commit final version in one pass per function |
| Design notes for items 2/3/4 | Doc updates in `docs/categories.md` + `docs/features/dashboard.md` AND inline JSDoc / TODO comments at the relevant call sites |
| Test framework | Vitest (web client) + Deno tests via local Supabase (edge functions); cover both Schedule C math and the new `reverse_sale` end-to-end |

## Workstreams

### A. Sign-handling fix + shared helper *(P0 item 1)*

**Problem.** `computeScheduleC`, `computeKPIs`, and `computeMonthlyChart` in [`DashboardPage.tsx`](../../../src/pages/DashboardPage.tsx) all share a buggy pattern: they branch on `t.amount > 0` to bucket income vs expense, then `Math.abs(amount) * mult` the expense side. A $50 supplies refund (which lands as `amount: +50` with `schedule_c_category: 'supplies'`) gets routed into the income bucket instead of subtracting from supplies expense — overstating both income and expenses, and corrupting the Schedule C breakdown.

**Fix.** Introduce one bucketing helper, route all three computations through it. Sum SIGNED amounts per category. Only `Math.abs()` at the display layer, after summing.

**Interface — `src/lib/categories.ts`:**

```ts
export type ScheduleCBucket = 'income' | 'expense' | 'cogs' | null
// null = excluded (settlement, related_sale_id, csv_import, isExcluded category, or uncategorized)

export interface BucketedAmount {
  bucket: ScheduleCBucket
  categoryValue: string | null   // null when bucket === null
  signedAmount: number           // post-meals-multiplier; preserves refund sign
}

export function bucketTransaction(t: Transaction): BucketedAmount
```

**Bucketing rules (single source of truth):**

| Condition | Result |
|---|---|
| `record_type === 'settlement'` | `null` |
| `related_sale_id` set | `null` (avoids double-counting sale-derived txns; sales side of the page does Profitability) |
| `source === 'csv_import'` | `null` (same rationale) |
| `net_zero_pair_id` set | `null` (cancels out) |
| `schedule_c_category` null/undefined | `null` (uncategorized) |
| Category `isExcluded === true` | `null` |
| Category `scheduleLine === 'Part I'` | `'income'`, signed `amount` |
| Category `scheduleLine === 'Part III'` | `'cogs'`, signed `amount` |
| Otherwise (Part II expenses) | `'expense'`, signed `amount * (mealsHalf ? 0.5 : 1)` |

Note `bucketTransaction` keeps the original sign. A refund posted to `supplies` (positive amount) becomes `{ bucket: 'expense', signedAmount: +50 }`. When summed into the supplies total it reduces it. Display layer renders `formatUSD(abs(total))` so the user always sees a positive expense number per line.

**Consumers rewritten:**

- `computeScheduleC` — `Object.entries(totals)` summing `signedAmount` per `categoryValue`.
- `computeKPIs` — let `incomeSum = Σ signedAmount over 'income' bucket` (already positive in the normal case; refunds-against-income subtract correctly). Let `expenseSum = Σ signedAmount over 'expense' bucket` (negative in the normal case; refunds-against-expense add positive values that partially offset). Then `income = incomeSum`, `expenses = abs(expenseSum)`, `net = incomeSum + expenseSum` (equivalent to `income − expenses`). Display uses `formatUSD(income)` and `formatUSD(expenses)`.
- `computeMonthlyChart` — same as KPIs, per month key. Bars use `incomeSum` and `abs(expenseSum)`.

The `net` value's existing semantic ("Income − Expenses") is preserved; only the per-bucket math changes. The user-visible behavior change: a refund posted to an expense category now reduces that expense (and therefore reduces total expenses and increases net) instead of inflating income.

### B. `reverse_sale` edge function + `deleteSale` rewrite *(P0 item 8)*

**Problem.** [`deleteSale`](../../../src/lib/mutations.ts) at L376–388 deletes the linked manual transactions and soft-deletes the sale, but leaves `inventory_lots.quantity_remaining` permanently decremented and orphan `inventory_movements` rows pointing at the soft-deleted sale. Every "I fat-fingered the sale, let me delete and re-record" workflow silently understates stock.

**Fix.** New edge function `supabase/functions/reverse_sale/index.ts` doing all four steps atomically in one Postgres transaction (service-role client). Client `deleteSale` becomes a thin wrapper.

**Edge function contract:**

- **Input:** `{ sale_id: string }`
- **Auth:** user JWT forwarded; function asserts `sales.user_id === auth.uid()` before doing anything.
- **Steps (single transaction):**
  1. `SELECT id, inventory_lot_id, quantity FROM inventory_movements WHERE sale_id = $1`
  2. For each movement: `UPDATE inventory_lots SET quantity_remaining = quantity_remaining + $qty WHERE id = $lot_id`
  3. `DELETE FROM inventory_movements WHERE sale_id = $1`
  4. `DELETE FROM transactions WHERE related_sale_id = $1 AND source = 'manual'`
  5. `UPDATE sales SET deleted_at = now() WHERE id = $1`
- **Output:** `{ ok: true, lots_restored: number, transactions_deleted: number }`
- **Errors:** sale not found / not owned by user → 403. Already soft-deleted → 409 (idempotency guard; otherwise replay would double-restore stock).

**Client side, `mutations.ts`:**

```ts
export async function deleteSale(id: string) {
  const { data, error } = await supabase.functions.invoke('reverse_sale', { body: { sale_id: id } })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
}
```

The existing `deleteSale` body (transactions delete + sales update) is replaced wholesale.

### C. Edge function fixes *(P0 items 5, 6, 7)*

Per-function workflow: `mcp__supabase__get_edge_function` → fix in editor → `mcp__supabase__deploy_edge_function` → commit final source to `supabase/functions/<name>/index.ts`.

**`record_sale` (item 6) — verify `fees`/`shipping_cost`.**

Currently the client's [`recordSale`](../../../src/lib/mutations.ts) wrapper invokes the edge function and then runs a follow-up `.update()` to write `fees` / `shipping_cost` / `net_payout` onto the sale. TASKS.md flags this because mobile's wrapper believed the function persisted these and they were silently dropped.

Two acceptable end states:

1. **Edge function accepts and persists them.** Drop the follow-up `.update()` block from `recordSale` (the `if (params.fees != null || params.shippingCost != null)` block, L242–253). Update edge function input contract to include `fees` and `shipping_cost`. Same for the linked transaction rows: `createSaleTransactions` could move server-side or stay client-side — keep client-side for now to minimize scope.
2. **Edge function ignores them; client writes them.** Keep the current client behavior, but document explicitly in the edge function source comment ("fees/shipping_cost are written by client after invocation; see `recordSale` in mutations.ts").

Decision deferred to implementation time based on what the current edge function source actually does — whichever requires less code change, pick that path and document it. Either way, write a Vitest fixture asserting fees/shipping land on the row after `recordSale` completes.

**`record_return` (item 5) — fix cost basis + create refund transaction.**

Two server-side bugs from mobile to fix:

1. Cost restoration uses `salePrice` instead of lot `unit_cost`. Should be `unit_cost` from the original `inventory_movements` rows being reversed.
2. No `transactions` row inserted for the refund. Should insert one with `amount: -refund_amount`, `schedule_c_category: 'returns_allowances'` (the category is added to `CATEGORIES` in this pass per section D, so it's available by the time this fix deploys), `related_sale_id: sale_id`, `source: 'manual'`.

Note: the *UI* for `record_return` doesn't exist on web yet (P1 item). This pass fixes the function so it's correct when that UI ships. We deploy the fixed function now; the existing function is not called by web today, so there's no behavior change risk to the live web client. Mobile may already call it — fixing it benefits both clients.

**`Sale.profit` partial return (item 7) — verify-only.**

Current [`SaleDetail` math in `SalesPage.tsx`](../../../src/pages/SalesPage.tsx) already subtracts `refunded_amount` for `return_status === 'partial'`. Confirm by reading the file and write a Vitest fixture (`SaleDetail.profit.test.ts`) covering: no return, partial return, full return. No code change expected — failing test → bug to fix.

### D. Design docs for items 2/3/4

These items are not bugs in code today. They're constraints for upcoming P1 features that would re-create the same class of tax bug if implemented naively. Capture both in prose docs (for someone reading docs to learn the system) and inline JSDoc / TODO comments (for someone editing the file).

**Item 2 — Part III scope mismatch.**

- New subsection in [`docs/features/dashboard.md`](../../features/dashboard.md): "Part III (Cost of Goods Sold) and inventory valuation". Explains that the Schedule C COGS line uses `beginning_inventory + purchases − ending_inventory` over the **full tax year** regardless of any dashboard period filter; the period-scoped Profitability card and the full-year Schedule C Part III card serve different purposes. Beginning/Ending values come from the planned `inventory_valuations(user_id, tax_year, beginning_inventory, ending_inventory)` table, not the period selector.
- JSDoc on `computeProfitability` in `DashboardPage.tsx` noting it is period-scoped and **must not** be reused to compute the Schedule C Part III line. Link to `docs/features/dashboard.md`.

**Item 3 — custom categories in Schedule C.**

- New subsection in [`docs/categories.md`](../../categories.md): "Custom categories". When the `custom_categories` table ships, `bucketTransaction` and the dashboard's Part I/II/III row builders must merge `CATEGORIES` with the user's custom categories at render time. The bucketing logic in `bucketTransaction` already handles arbitrary category strings — the *display* code in `DashboardPage.tsx` (the three `CATEGORIES.filter(...)` blocks) is what hard-codes the built-in list and must become data-driven.
- JSDoc on the three `CATEGORIES.filter(c => c.scheduleLine === ...)` blocks in `DashboardPage.tsx` noting this must merge with `useCustomCategories()` when added.

**Item 4 — Returns & Allowances bucket.**

- New `categories.md` entry placeholder for `returns_allowances` category (Part I, displayed as a negative line below "Gross Receipts" reducing Line 1). Add the actual `CategoryDef` to `CATEGORIES` *in this pass* so the `record_return` fix in section C can reference it; even though no UI ships yet, having the category present is harmless.
- Inline `// TODO(p1-returns)` comment in the Part I render section of `DashboardPage.tsx` noting refunds should subtract from gross, not net silently.

### E. Test infrastructure

**Dev deps to add:**

- `vitest`
- `@vitest/ui`
- `happy-dom`
- `@testing-library/react`
- `@testing-library/jest-dom`

**`package.json` scripts:**

```json
"test": "vitest run",
"test:watch": "vitest",
"test:ui": "vitest --ui"
```

**`vitest.config.ts`** — minimal config, `environment: 'happy-dom'`, picks up `**/*.test.{ts,tsx}`.

**Vitest test files (client):**

| Path | Covers |
|---|---|
| `src/lib/__tests__/bucketTransaction.test.ts` | All bucketing rules: positive income, negative expense, refund in expense (signed +), meals 50%, isExcluded, settlement filter, related_sale_id filter, csv_import filter, net_zero_pair filter, uncategorized |
| `src/lib/__tests__/scheduleCMath.test.ts` | `computeScheduleC` / `computeKPIs` / `computeMonthlyChart` over fixture transactions. **Includes the regression case** (refund in supplies → reduces supplies expense, does not inflate income) |
| `src/pages/__tests__/SaleDetail.profit.test.ts` | Partial return profit math: no return, partial, full |

**Deno test files (edge functions):**

| Path | Covers |
|---|---|
| `supabase/functions/reverse_sale/index.test.ts` | Given a seeded sale with 2 movements depleting 2 lots, asserts: lots' `quantity_remaining` restored, movements deleted, linked manual transactions deleted, sale `deleted_at` set. Idempotency: second call returns 409. Ownership: call with a different user's JWT returns 403. |
| `supabase/functions/record_return/index.test.ts` | Cost restoration uses lot `unit_cost` not `salePrice`. Refund `transactions` row inserted with correct amount/category/related_sale_id. |
| `supabase/functions/record_sale/index.test.ts` | (Light) — asserts fees/shipping_cost end state on the sale row after `recordSale` completes end-to-end. |

**Edge function tests run via local Supabase** (`supabase start`, point Deno tests at the local stack). Sets up the long-term local-dev story for the rest of the porting work. CI configuration is out of scope for this pass — tests run locally.

## File-change summary

| File | Change |
|---|---|
| `src/lib/categories.ts` | Add `bucketTransaction`, `ScheduleCBucket`, `BucketedAmount`; add `returns_allowances` to `CATEGORIES` |
| `src/lib/mutations.ts` | Rewrite `deleteSale` as `reverse_sale` invoker; possibly trim `recordSale` fees/shipping block (decision deferred to section C) |
| `src/pages/DashboardPage.tsx` | Rewrite `computeKPIs` / `computeMonthlyChart` / `computeScheduleC` on top of `bucketTransaction`; add JSDoc per section D |
| `docs/categories.md` | Add Custom categories + Returns & Allowances subsections |
| `docs/features/dashboard.md` | Add Part III / inventory valuation subsection |
| `docs/superpowers/specs/2026-06-23-p0-tax-correctness-design.md` | This file |
| `supabase/functions/reverse_sale/index.ts` | New |
| `supabase/functions/reverse_sale/index.test.ts` | New |
| `supabase/functions/record_return/index.ts` | New (committed from pulled+fixed source) |
| `supabase/functions/record_return/index.test.ts` | New |
| `supabase/functions/record_sale/index.ts` | New (committed from pulled[+possibly fixed] source) |
| `supabase/functions/record_sale/index.test.ts` | New |
| `vitest.config.ts` | New |
| `package.json` | Add test deps + scripts |
| `src/lib/__tests__/bucketTransaction.test.ts` | New |
| `src/lib/__tests__/scheduleCMath.test.ts` | New |
| `src/pages/__tests__/SaleDetail.profit.test.ts` | New |

## Implementation order

1. Vitest install + config + smoke test
2. `bucketTransaction` helper + unit tests
3. Rewrite three dashboard functions on the helper + math tests *(item 1 done)*
4. Doc updates + inline comments for items 2/3/4; add `returns_allowances` to `CATEGORIES` *(items 2/3/4 done)*
5. Pull `record_sale`, verify fees/shipping handling, commit (with or without server-side change per section C) *(item 6 done)*
6. Pull `record_return`, fix both bugs, write Deno test, deploy, commit *(item 5 done)*
7. Write `reverse_sale` + Deno test, deploy, commit
8. Rewrite client `deleteSale` to invoke `reverse_sale` *(item 8 done)*
9. Vitest fixture for `Sale.profit` partial-return path *(item 7 done)*

Each numbered step is a candidate commit boundary.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `record_sale` rewrite breaks mobile | Decide in section C whether to change server behavior or just verify+document. If we change it, keep the input contract backwards compatible (accept fees/shipping as optional). |
| `reverse_sale` race with a concurrent `record_sale` on same lots | Single transaction with row-level locks (`SELECT ... FOR UPDATE` on lot rows) eliminates the race. Already standard for inventory writes in Postgres. |
| Deno tests require local Supabase running | Acceptable — same constraint applies to anyone iterating on edge functions. Document `supabase start` requirement in the new functions' READMEs (or in `supabase/functions/README.md`). |
| Pulled edge function source has secrets / env-coupled code | Strip / parameterize before commit. Review each pulled function before deploying its rewrite. |
| Test fixtures drift from production schema | Tests use `Transaction` and `Sale` types from `src/lib/types.ts`; if schema changes the type changes and tests fail to compile. |

## Acceptance criteria

- All eight P0 items in `TASKS.md` checked off with linking commit hashes.
- `npm run test` passes (Vitest); `supabase functions test` (or equivalent Deno test runner) passes.
- `npm run build` passes.
- `npm run lint` passes.
- Manual smoke: log in, view dashboard with a fixture containing a refund in an expense category, confirm the supplies expense total is reduced not inflated; record a sale; delete the sale; confirm the lot's `quantity_remaining` is restored.
- Docs updated per section D; `docs/README.md` links the new subsections if applicable.
