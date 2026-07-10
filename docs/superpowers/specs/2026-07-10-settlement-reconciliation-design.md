# Settlement / Disbursement Reconciliation

**Status:** Draft — awaiting user review
**Date:** 2026-07-10
**Author:** Brainstormed with Claude, prompted by a compliance review (see companion [`2026-07-10-compliance-review-findings.md`](2026-07-10-compliance-review-findings.md), finding F-09)

## Background

The user sells across FB Marketplace, eBay, Amazon, and TCGPlayer. Marketplace platforms don't pay out per-sale — they accumulate sales, fees, ad spend, shipping-label charges, and refund clawbacks into a holding balance and disburse it to the bank in a lump sum on a schedule (weekly for most, per-transaction for FB local cash). A single disbursement can span dozens of sales; a single sale's components (payout, fee) can land in *different* disbursements if a refund crosses a settlement boundary. Trying to link one bank deposit to specific sales 1:1 doesn't work — the relationship is many-to-many by nature, not a data-modeling gap.

The schema already has partial scaffolding for this: `transactions.record_type = 'settlement'`, `parent_settlement_id`, `csv_transaction_id` (see `docs/supabase-schema.md`) — "CSV-import/settlement linkage, not yet exercised by any UI in this repo." `TASKS.md` already lists a P1 **Settlement Status view** (port of mobile's `SettlementStatusView`/`SettlementDetailView` — segmented platform picker, Needs Breakdown / Breakdown Imported sections, disbursement matching UI) and a P2 **"Settlements warning on export"** (block/warn CSV export if unbroken settlements exist in the period). This spec is the accounting design underneath those UI items — it answers *what a settlement should mean*, not just what the screen looks like.

### The finding that makes this more than a nice-to-have

`bucketTransaction` unconditionally excludes any transaction with `related_sale_id` set (`categories.ts:158`) — and every payout/fee/shipping row `createSaleTransactions` creates for a manually-recorded sale carries that field. Traced end to end: **`computeScheduleC`'s Part I never includes sale revenue, and Part II Line 10 / Line 27a never include sale fees or shipping, for anyone recording sales manually today.** That income only shows up in the separate Sales Profitability card (`computeProfitability`). The existing rationale (`data-flows.md`) assumes a bank-deposit transaction, categorized `payout`, will eventually carry the income once Plaid ships — but that deposit-side transaction doesn't exist for manual-entry users, so the Dashboard's headline Schedule C widget is silently incomplete right now, before Plaid is even in the picture. Fixing settlement reconciliation and fixing this Schedule C gap are the same piece of work — see "Convention change" below.

## Accounting model (locked in — CPA-correct)

**A disbursement is a transfer, never income.** The taxable event happens at the sale (cash-basis: when the buyer paid / constructive receipt), not when the platform gets around to disbursing the accumulated balance. Modeling the deposit as income would slide a late-December sale's revenue into January and mismatch the platform's own 1099-K, which reports based on transaction date, not payout date.

### The itemized layer is Schedule C truth; the deposit is a check-figure

- Every sale's payout, fee, and (if any) shipping/ad/subscription charge is its own `transactions` row, itemized and categorized, the moment the sale happens — this is unchanged from today's `createSaleTransactions` behavior.
- The bank deposit itself is tagged `record_type = 'settlement'` and **excluded** from every Schedule C aggregate (already true — settlements hit the `null` bucket in `bucketTransaction`, first rule in the table).
- The deposit's only job is to be a **reconciliation target**: the itemized components that belong to it (by platform + date range, matched via the platform's payout/settlement report) must sum to the deposit amount. Any residual is a signal — a hold, an unimported ad charge, a subscription fee — not noise to be ignored.

### Convention change required: itemized rows must count toward Schedule C

Per F-09, `bucketTransaction`'s `related_sale_id` exclusion needs to stop being unconditional. The fix: sale-linked transactions count toward Schedule C **unless** their sale is also linked to a CSV-imported settlement whose components are independently itemized through the settlement-breakdown flow below (to avoid double-counting once CSV import ships). Concretely:

- **Manual sales (today):** `createSaleTransactions` rows have no settlement linkage — they should flow through `bucketTransaction` normally. This alone fixes F-09 for the app's current usable state.
- **CSV-imported sales (future):** revenue/fee components arrive already itemized from the platform's settlement report. Those rows are the Schedule C truth; the settlement/deposit row stays excluded as today.
- Net effect: **the sale event (not the bank deposit) is always what drives Schedule C**, regardless of source. This is the single mental model that makes "when did I get paid" irrelevant to "when do I owe tax on it" — which is exactly right for cash-basis sellers on marketplace platforms.

### Gross, not net

Line 1 (gross receipts) must equal what the platform reports on the 1099-K — full sale price, before fees. Fees are a separate, provable Line 10 deduction. Never book `net_payout` as the income transaction; the existing `payout` (gross) / `commissions_fees` (negative) / `shipping_postage` (negative) three-row split in `createSaleTransactions` already gets this right and should stay the pattern CSV-imported settlement components follow too.

## Data model

Reuses existing columns; no new tables required for the core reconciliation loop. One new table for the itemized non-sale components a settlement can carry (ad spend, subscription fees, label charges) that today have nowhere to live.

### Existing (already in schema, per `docs/supabase-schema.md`) — confirmed still fit for purpose

| column | table | role in this design |
|---|---|---|
| `record_type` | `transactions` | `'settlement'` marks the deposit row itself — stays excluded from Schedule C |
| `parent_settlement_id` | `transactions` | links an itemized component row to the settlement/deposit it was paid out in |
| `csv_transaction_id` | `transactions` | links an itemized row back to its source line in an imported settlement report |
| `related_sale_id` | `transactions` | links payout/fee/shipping rows to their sale — **now also drives Schedule C inclusion, see convention change above** |

### New table: `settlement_platform_charges`

Non-sale-linked components a settlement can carry — advertising/promoted listings, store subscription fees, label/postage charges not tied to a specific sale, adjustments. These are real expenses withheld from the payout that have no `sales` row to attach to.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | RLS-scoped |
| `created_at` | timestamptz | |
| `settlement_transaction_id` | uuid FK | the `transactions` row with `record_type = 'settlement'` this charge was withheld from. `ON DELETE CASCADE` (a charge with no settlement to belong to is meaningless) |
| `transaction_id` | uuid FK | nullable; the itemized expense `transactions` row created for this charge (categorized `advertising`, `office_expense`, etc. per type) |
| `charge_type` | text | `'advertising' \| 'subscription' \| 'label_fee' \| 'adjustment' \| 'other'` |
| `amount` | numeric | positive magnitude |
| `platform_description` | text | raw description from the platform's report, kept for audit trail |

### Modified: reconciliation is a computed view, not a stored value

A settlement's reconciliation status is derived, not stored: `sum(components where parent_settlement_id = settlement.id) + sum(settlement_platform_charges.amount where settlement_transaction_id = settlement.id) ?= settlement.amount`. Keeping this computed (rather than caching a `reconciled` boolean) avoids a second source of truth that can drift when a component is added/edited/removed after the fact.

## Mutation layer (`src/lib/mutations.ts`)

### New: `markTransactionAsSettlement`
Flags an imported bank/Plaid transaction as a platform disbursement (`record_type: 'settlement'`) rather than income. Reversible (`unmarkSettlement`) in case of a mis-click. Auto-suggestion (UI, not a mutation): when a deposit's merchant/description matches a known platform pattern (`EBAY`, `AMAZON`, `TCGPLAYER`, `PAYPAL` doing FB/Marketplace payouts), prompt "Mark as settlement?" so the itemized-vs-settlement split doesn't rely on the user remembering to do it.

### New: `linkComponentToSettlement`
Sets `parent_settlement_id` on an itemized `transactions` row (a sale's payout/fee row, or a manually-entered platform charge) to point at a settlement row. Used both by the future CSV-settlement-import matcher and by manual reconciliation of manually-entered sales against a real deposit.

### New: `addSettlementPlatformCharge`
Creates a `settlement_platform_charges` row and its linked expense `transactions` row (categorized per `charge_type`: `advertising` → `advertising`, `subscription`/`label_fee`/`other` → `office_expense` or `shipping_postage` as appropriate) in one step, so ad spend and subscription fees withheld from a payout stop disappearing into the net deposit number.

### `computeSettlementReconciliation(settlementId)` (read-side helper, `src/lib/queries.ts`)
Returns `{ depositAmount, componentSum, chargeSum, residual }` for a settlement. `residual !== 0` (outside a cent tolerance) is the single signal the UI needs to show "needs attention."

## UI

Builds directly on the already-planned **Settlement Status view** (`TASKS.md` P1, CSV Import section) rather than introducing a new page:

- **Segmented platform picker** (as already speced): eBay / Amazon / TCGPlayer / FB (once each has sales flowing through it).
- Per-settlement row: deposit amount, reconciliation status pill (✓ Reconciled / ⚠ Off by $X), expandable component list (payout/fee pairs per sale, platform charges, refund clawbacks).
- **"Needs Breakdown"** section (already speced): settlements with `residual !== 0`, sorted oldest-first — the actual weekly worklist.
- Manual-entry path (works today, before CSV import ships): user marks a bank deposit as a settlement, then uses `linkComponentToSettlement` to attach the manual sales they know belong to it. Residual shown live as they attach.
- **Export gate** (`TASKS.md` P2, "Settlements warning on export"): once the Schedule C export ships, block or warn if any settlement in the export period has a non-zero residual — this is the natural enforcement point for the reconciliation this spec defines.

## Edge cases

- **A sale's fee lands in a different settlement than its payout** (refund or fee adjustment posted after the original settlement closed) — both components still just carry their own `parent_settlement_id`; nothing requires a sale's components to share one settlement. The sale itself is still whole (all its rows share `related_sale_id`); only their settlement linkage differs.
- **A settlement fully explained but off by a few cents** — treat within a $0.02 tolerance as reconciled (matches the existing `0.01` balance tolerance pattern used in `recordTrade`); anything larger surfaces.
- **FB Marketplace cash sales never touch a "settlement" at all** — a cash sale's payout transaction has no settlement to reconcile against; it's already complete the moment it's entered. The reconciliation UI simply has nothing to show for these, which is correct.
- **Settlement marked by mistake** — `unmarkSettlement` reverts `record_type` to `'transaction'`; if components were already linked to it, warn before allowing (they'd silently start counting as income again once unmarked, since a non-settlement `payout`-categorized row is not otherwise excluded).

## Out of scope (v1)

- **Automated settlement-report import/matching** — depends on the CSV import feature (`TASKS.md` P1) shipping first; this spec defines the data model and manual-entry path so it's ready when CSV import lands.
- **Cross-settlement automatic component splitting** — the app never guesses which portion of a lump deposit belongs to which sale; matching is always by explicit link (manual today, CSV-report-driven later), never a pro-rated formula.
- **Per-platform payout schedule configuration** (e.g. "eBay pays out daily, TCGPlayer weekly") — informational only, not needed for the reconciliation math itself.

## Documentation updates (same PR as implementation)

Per `CLAUDE.md` doc-maintenance rule:
- `docs/supabase-schema.md` — document `settlement_platform_charges`; clarify `record_type`/`parent_settlement_id`/`csv_transaction_id` are now load-bearing, not vestigial.
- `docs/data-flows.md` — add a "Settlement reconciliation" section; update "why `related_sale_id` is excluded" note per the convention change (it's no longer excluded — only settlement-linked *duplicate* itemization is).
- `docs/categories.md` — note that `bucketTransaction`'s `related_sale_id` exclusion rule changes per this spec.
- `docs/features/sales.md` / a new `docs/features/settlements.md` — document the Settlement Status view once built.
- `TASKS.md` — cross-referenced in this same change (see P1 "Settlement Reconciliation" subsection).

## Success criteria

- A manually-recorded sale's payout and fee now appear in the Dashboard's Schedule C Part I / Part II breakdown without any settlement involved (fixes F-09 immediately, independent of the rest of this spec).
- A bank deposit marked as a settlement is excluded from every Schedule C total.
- Manually linking known sales to a settlement drives its residual toward $0, and the UI shows the exact remaining gap at every step.
- A settlement whose components sum to the deposit within $0.02 shows "Reconciled"; anything larger shows the specific dollar residual, not just a generic warning.
- Hand-tally of one real weekly eBay disbursement (payouts + fees + one ad charge + one refund clawback) reconciles to the deposit amount using this model.
