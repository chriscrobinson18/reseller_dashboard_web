# Golden-Path Transaction & Schedule C Data Model — Design

_Date: 2026-09-01_
_Status: **Spec only** — no code written, no migration applied. Supersedes the settlement-anchoring approach sketched mid-review; this is the full model it was a piece of._

Establishes one authoritative shape for `transactions` so that **Schedule C, per-SKU
profitability, and quarterly net profit are all derived from the same rows by the same
rule**. Today they are not: two independent engines compute Schedule C with contradictory
filters, and the join key per-SKU profit needs does not exist as a column.

This is a **net simplification**. It deletes more code than it adds.

---

## Goal

The app has three jobs (`CLAUDE.md`, and the user's own framing):

1. **Taxes / Schedule C** — a defensible Line 1 … Line 31.
2. **SKU profitability** — per-item profit, not just per-sale.
3. **Inventory / net profit tracking** — where I stand each quarter.

All three are downstream of one question: *which rows count, and how do they group?*
This spec answers that once.

---

## The problem, stated precisely

### P1. Two Schedule C engines with contradictory filters

`bucketTransaction` (`src/lib/categories.ts:157-160`) drives the **on-screen** Dashboard
KPI row, Schedule C Breakdown card, and monthly chart. It drops:

```ts
if (t.record_type === 'settlement') return none
if (t.related_sale_id) return none      // every recordSale payout row
if (t.source === 'csv_import') return none  // every eBay/Amazon/Mercari CSV row
if (t.net_zero_pair_id) return none
```

`computeScheduleCSummary` (`src/lib/csvExport.ts:157`) drives the **Summary CSV** — the
artifact that would be filed. It honors only the settlement skip. It has neither the
`related_sale_id` nor the `csv_import` filter, and its docstring asserts the opposite
policy outright ("Sale-linked … rows ARE included — that is where sales income and
selling costs live").

**Worked example.** One row, `{ amount: 1000, schedule_c_category: 'payout',
related_sale_id: 's1' }`:

| Engine | Result |
| --- | --- |
| `bucketTransaction` | `related_sale_id` set → `none` → **$0** in Total Income and Part I |
| `computeScheduleCSummary` | `perLine['Part I'] += 1000` → **$1,000** on Line 1 |

Both behaviors are covered by tests (`csvExport.test.ts:125` asserts the row lands in
gross receipts; `bucketTransaction.test.ts` asserts it is filtered). **No test asserts the
two engines agree.** The divergence is encoded as correct in both directions.

Consequence: the number on screen and the number filed can differ by the whole of
marketplace revenue, in either direction depending on live data.

### P2. Deduplication is a per-transaction heuristic, and it is broken

`sync_ebay_transactions/index.ts:455` finds the Plaid deposit matching an eBay payout so
it can be re-tagged `transfer` (preventing a double-count against the eBay API rows):

```ts
.neq('schedule_c_category', 'transfer')
```

In Postgres `NULL <> 'transfer'` evaluates to NULL, not TRUE, so PostgREST's `.neq`
**silently excludes every uncategorized row**. A freshly-synced Plaid deposit is exactly
that. The dedup step therefore rarely fires on new deposits, and eBay revenue is counted
twice — once from the API detail, once from the bank deposit.

Three further defects in the same matcher:

- No account scoping — matches any Plaid row in the window.
- Matches on `Math.abs(m.amount)`, so a **debit** of $79 matches a **payout** of $79. A
  same-value purchase can be re-tagged `transfer`, silently deleting a real deduction.
- ±2 day window, first-match-wins rather than nearest-by-date. eBay commonly settles
  3–5 business days out.

### P3. The join key for goal 2 is a free-text field

`external_order_id` exists on `sales` and `sale_bundles`. It **does not exist on
`transactions`**. `src/lib/csvReturns.ts:20` documents the workaround: the order ref is
matched against **`transactions.notes`**.

Per-SKU profitability needs revenue, fees, and shipping for one order joined to the FIFO
cost of the item sold. Without an indexed order key on `transactions`, that join is a
string search. This is why goal 2 is unbuilt: `saleProfit.ts` is per-sale,
`computeProfitability` is per-period, and nothing groups by item.

### P4. The one thing that already works

`record_type === 'settlement'` is honored **identically** by both engines
(`categories.ts:157` and `csvExport.ts:63,157`). Where the settlement model is used, the
Dashboard and the filed CSV agree. `queries.ts:352-385` carries real reconciliation math —
`getExpectedDeposit` / `getNetTotal` / `getAdjustedTotal` / `getClosingReserve`, with
`priorBalance` chaining reserve across statements.

**This spec generalizes the one mechanism that works to all sources, and deletes the
mechanisms that don't.**

---

## The model

### The overlap is one row per deposit

| What Plaid sees | Also in a marketplace feed? |
| --- | --- |
| Marketplace payout deposit | **Yes — the only overlap** |
| Inventory purchases (eBay, COMC, shows) | No — seller feeds exclude your buying |
| Postage bought off-platform (Pirate Ship) | No |
| Supplies, software, subscriptions, mileage | No |
| Store/ad fees charged to a card | Sometimes |

Income arrives from platforms; expenses arrive from the bank; they meet at exactly one
row per deposit. The ambiguous last case resolves itself without a special rule:

> **A platform detail row is P&L if and only if it was netted *inside* a deposit.
> The deposit is the boundary.**

A fee netted out of a payout is a child of that settlement. A fee charged to a card is a
Plaid row. The reconciliation arithmetic decides — a card-charged fee is not inside the
deposit, so it never becomes a child, so it stays a standalone P&L row.

### Roles

Every transaction is exactly one of three things:

| `role` | What it is | Counts in Schedule C? |
| --- | --- | --- |
| `pnl` | A real economic event | **Always** |
| `settlement` | A bank deposit that nets P&L rows | Never — checksum only |
| `internal` | Transfer, card payment, non-cash trade leg | Never |

### Two join keys, two axes

- **`parent_settlement_id`** (exists) — vertical. Ties a deposit to the rows netting into
  it. Answers *did I capture everything?* → goals 1, 3.
- **`order_id`** (new) — horizontal. Ties gross/fee/shipping/refund rows for one order
  together, and to the `sales` row that consumed inventory. Answers *what did this SKU
  make?* → goal 2.

```
SETTLEMENT  (Plaid deposit, role='settlement' — never counted)
│  amount: $79.00     invariant: children + priorBalance − closingReserve = amount
│
├─ ORDER  ebay-1234
│   +$100.00  gross     → Line 1     ┐ group by order_id
│    −$13.00  fee       → Line 10    │ = full unit economics
│     −$8.00  shipping  → Line 27a   ┘
│        └──► sales row (external_order_id) ──► inventory_movements ──► lot.unit_cost
│
└─ ORDER  ebay-5678 …

STANDALONE  (role='pnl', no settlement)
   −$240.00  inventory purchase → Part III / lot funding
    −$14.99  supplies           → Line 22
    +$60.00  cash sale          → Line 1   (+ its own sales row)
```

### Ingestion rules

| Source | Lands as | Keys |
| --- | --- | --- |
| **Plaid** | `role='pnl'`, uncategorized | — |
| ↳ *matched to a platform payout* | flips to `role='settlement'` | — |
| **eBay API** | `role='pnl'` | `order_id` from `references[]`; `parent_settlement_id` from `payoutId` |
| **Amazon / Mercari CSV** | `role='pnl'` | `order_id` from the order column; `parent_settlement_id` from the settlement id |
| **Cash / in-person** | `role='pnl'` + a `sales` row | no settlement |

**The central shift: match once per deposit, not once per transaction.** eBay's Finances
API returns `payoutId` on every transaction; Amazon's settlement report is organized by
settlement id. So `parent_settlement_id` on children comes **from the feed, free**. The
only amount-matching left is feed-payout ↔ bank-deposit: one row per payout, a
distinctive amount in a known account on a known date. That is a reliable match; the
current per-transaction matching is not.

### The read rule

```ts
// Schedule C, all of it, one engine:
transactions.filter(t => t.role === 'pnl')
```

No source filters. No exclusion lists. No second engine. The filtering already happened at
write time, which is the point.

---

## Decisions

**D1 — `role` is a column, not derived.** Deriving it at read time is what produced two
engines. A stored, checked column is the single source of truth and is queryable from SQL
for audits.

**D2 — The deposit is never P&L.** Schedule C wants gross receipts (Line 1) and
commissions (Line 10) as separate numbers. A $79 net deposit can only ever be $79 of one
thing. Reporting net receipts on Line 1 also *understates* the fee deduction — worse for
the filer, not just wrong.

**D3 — `role` supersedes `record_type` and the `isExcluded` category hack.** Today
"doesn't count" is expressed three ways: `record_type='settlement'`, four `isExcluded`
categories, and `net_zero_pair_id`. All three collapse into `role`. `isExcluded` stays on
`CategoryDef` only for the category picker's UI affordance, not for math.

**D4 — `related_sale_id` and `related_bundle_id` become display links only.** They stop
affecting whether a row counts. A cash sale's payout row is real income and must count;
today `bucketTransaction` drops it, which understates income. This is a behavior change
and is the highest-risk part of the backfill — see R2.

**D5 — `recordSale` stops creating transactions for marketplace sales.** Those rows arrive
from the feed. `createSaleTransactions` (`mutations.ts:822`) remains only for
cash/in-person sales where no feed exists. This removes the structural source of
`related_sale_id` duplication rather than filtering it at read time.

**D6 — Unreconciled settlements block export, not warn.** If an import is skipped, a
deposit exists with no children and revenue silently reads $0. Silent zero is the worst
failure mode available. The Summary CSV export must refuse while unreconciled settlements
exist in the period. (This is the `Settlements warning on export` P2 item; under this
model it is a safety interlock, not polish.)

**D7 — COGS sourcing is out of scope and unchanged.** Line 4 remains `cost_of_goods`
purchase transactions (cash basis, as stated in the CSV header). The §471 vs §471(c)
blocker in `TASKS.md` is a filing-method question for whoever signs the return and is
**not** resolved here. This spec is orthogonal to it: it changes *which rows count*, not
*when inventory cost is recognized*.

---

## Backfill

### Mapping

| Condition (first match wins) | `role` |
| --- | --- |
| `record_type = 'settlement'` | `settlement` |
| `schedule_c_category IN (transfer, personal, settlement, balance_adjustment)` | `internal` |
| `net_zero_pair_id IS NOT NULL` | `internal` |
| everything else | `pnl` |

Custom categories inheriting an excluded parent (via `parentValue`) must resolve to
`internal` too — the backfill cannot read `resolveCategory`, so it needs a join against
`custom_categories` on `parent_value`.

### Verification gate — run before `UPDATE`

The backfill is **not** safe to apply unverified, because D4 changes which rows count.

1. Run the mapping as a `SELECT` producing `(role, count, sum(amount))`.
2. Recompute Schedule C from the proposed roles for **one closed month**.
3. Compare line-by-line against the current Summary CSV for that month.
4. Investigate every delta before applying. Expected deltas are `related_sale_id` and
   `csv_import` rows appearing on screen for the first time; unexpected deltas mean the
   mapping is wrong for this dataset.

### The open data question

D4 assumes `related_sale_id` payout rows are **cash/in-person sales with no corresponding
bank deposit**. If any were marketplace sales recorded manually *and* also imported, they
are duplicates and marking them `pnl` doubles that revenue. This cannot be settled from
the code — it needs the live dataset:

```sql
select source, schedule_c_category,
       related_sale_id is not null as sale_linked,
       count(*), sum(amount)
from transactions
where schedule_c_category = 'payout'
  and date >= '2026-01-01'
group by 1,2,3
order by 5 desc;
```

If sale-linked rows have near-duplicate Plaid or feed rows at the same amount and date,
those specific rows map to `internal`, not `pnl`. **Resolve this before Phase 2.**

---

## What gets deleted

| Removed | Where |
| --- | --- |
| `if (t.source === 'csv_import') return none` | `categories.ts:159` |
| `if (t.related_sale_id) return none` | `categories.ts:158` |
| `record_type` as a math input | `categories.ts:157`, `csvExport.ts:63,157` |
| `net_zero_pair_id` pairing as a math input | `categories.ts:160` |
| The payout↔deposit amount-matching heuristic (~60 lines, 4 defects) | `sync_ebay_transactions/index.ts:440-480` |
| The second Schedule C engine's independent filter set | `csvExport.ts:157+` |
| `createSaleTransactions` for marketplace sales | `mutations.ts:822` |

Added: two columns, two indexes, one `role` check, one shared predicate.

---

## Profitability (goal 2) falls out

With `order_id` indexed on `transactions`, per-SKU profit is a query, not a feature:

```
group transactions where role='pnl' by order_id
  → revenue   = sum(amount > 0)
  → fees      = sum(commissions_fees)
  → shipping  = sum(shipping_postage)
join sales on external_order_id
  → item_id, inventory_movements → lot.unit_cost = COGS
group by item_id
  → unitsSold, revenue, cogs, fees, shipping, profit, margin%
```

New file `src/lib/itemProfit.ts`, pure functions, unit-testable with no DB. Rendered as
sortable columns on the existing Inventory table (`InventoryPage.tsx:682-688`, which today
shows only In Stock / Value at Cost / Avg Cost / Lots).

Manual/cash sales work immediately via `related_sale_id`; marketplace orders need Phase 3.

---

## File-change summary

| File | Change |
| --- | --- |
| `supabase/migrations/<ts>_transaction_roles.sql` | **new** — `role` + `order_id` columns, check constraint, 2 indexes |
| `supabase/migrations/<ts>_transaction_roles_backfill.sql` | **new** — mapping above, gated on the verification step |
| `src/lib/types.ts` | `Transaction.role`, `Transaction.order_id`; `source` union gains `'ebay_api'` (currently missing — pre-existing drift) |
| `src/lib/categories.ts` | `bucketTransaction` → single `role === 'pnl'` test |
| `src/lib/csvExport.ts` | `computeScheduleCSummary` + `scheduleCExportRows` consume `bucketTransaction` |
| `src/lib/__tests__/scheduleCReconciliation.test.ts` | **new** — the two engines agree |
| `src/lib/__tests__/bucketTransaction.test.ts` | rewrite the four filter cases against `role` |
| `src/lib/itemProfit.ts` + test | **new** — per-SKU rollup |
| `src/pages/InventoryPage.tsx` | profit columns |
| `supabase/functions/sync_ebay_transactions/index.ts` | delete the matcher; write `order_id` + `parent_settlement_id` from the feed; NULL-safe + `amount > 0` guards on the one remaining payout↔deposit match |
| `src/lib/mutations.ts` | `createSaleTransactions` restricted to non-marketplace sales |
| `docs/supabase-schema.md`, `docs/categories.md`, `docs/features/dashboard.md` | document `role`, `order_id`, the read rule |

---

## Implementation order

**Phase 1 — Foundation (no importer changes).** Migration, backfill + verification gate,
collapse to one engine, reconciliation test. **After this the two numbers agree.**
Independent of any feed work.

**Phase 2 — Behavior change.** D4/D5: `related_sale_id` rows count; `recordSale` stops
creating marketplace rows. Gated on the open data question above.

**Phase 3 — Importers.** eBay then Amazon: write `order_id` + `parent_settlement_id` from
the feed; delete the heuristic. Incremental, per-platform.

**Phase 4 — Profitability.** `itemProfit.ts` + Inventory columns. Works for manual sales
after Phase 1; complete after Phase 3.

**Phase 5 — Interlock.** D6: block Summary CSV export on unreconciled settlements.

---

## Risks and mitigations

**R1 — The migration rewrites every row's meaning.** It changes what the Dashboard has
shown all year. *Mitigation:* the verification gate; `SELECT` before `UPDATE`; reconcile
one closed month by hand first.

**R2 — D4 could double-count.** If sale-linked rows have importer twins, marking them
`pnl` doubles revenue. *Mitigation:* the diagnostic query; Phase 2 is separated from
Phase 1 precisely so Phase 1 can ship without it.

**R3 — Timing.** Do not run this between now and filing. Either complete and verify it
well before pulling numbers, or file on the current model and migrate after.

**R4 — Reserves make the invariant non-exact.** Amazon holds reserves; `sum(children) ≠
deposit` legitimately. *Mitigation:* the existing `priorBalance`/`closingReserve` chain in
`queries.ts:352-385` already models this — reuse it; do not reimplement.

**R5 — One statement, many deposits.** `parent_settlement_id` is a single FK, so an eBay
statement spanning several payouts cannot point at all of them. *Mitigation:* key eBay
settlements on `payoutId` so each payout is its own settlement — the clean 1:1 case. No
join table needed.

**R6 — No Supabase CLI in the authoring session.** Migrations and edge-function changes are
source-only until deployed, the same constraint that left `plaid_exchange_token` v18 and
the CSV-return v2 functions undeployed. *Mitigation:* track deployment explicitly in
`TASKS.md` and the `docs/supabase-schema.md` Deployment note; do not mark phases complete
on merge alone.

---

## Acceptance criteria

1. `computeKPIs(fx).net === computeScheduleCSummary(fx).netProfit` for every fixture,
   asserted in CI.
2. `bucketTransaction` contains exactly one inclusion test: `role === 'pnl'`.
3. Every transaction row has a non-null `role`; the check constraint holds.
4. For a reconciled settlement, `sum(children) + priorBalance − closingReserve = amount`.
5. Mercari/Amazon CSV revenue appears on the Dashboard (it reads $0 today).
6. Per-SKU profit is available for every item with at least one linked sale.
7. Summary CSV export refuses while unreconciled settlements exist in the period.
8. A closed month's Schedule C summary is unchanged by the migration, except for deltas
   explained and signed off during the verification gate.

---

## Deliberately out of scope

- **The §471 vs §471(c) inventory-accounting decision** (D7) — a filing-method question,
  still open in `TASKS.md`, unaffected by this spec.
- **Beginning/ending inventory valuation** — blocked on that decision.
- **New marketplace integrations** — this spec makes adding one cheaper; it does not add
  one.
- **Trades, bundles, box openings** — they write ordinary rows and will carry `role='pnl'`
  by default. Frozen, not extended, not deleted.
- **The `sales` table's shape** — unchanged. It remains the inventory/FIFO event; this
  spec only adds the key that joins it to the money.
