# CSV Return Reconciliation — Design Doc

_Date: 2026-08-27_
_Status: Built as source — **not deployed** (migration + edge function changes need a Supabase CLI session). See the 2026-08-27 Deployment note in `docs/supabase-schema.md`._

Implements the "Proposed: the CSV reconciliation layer" section of
[`docs/superpowers/specs/2026-07-10-returns-design.md`](2026-07-10-returns-design.md),
model **C (hybrid)**: `record_return`/`reverse_return` stay the single
inventory-restoring primitive; a review-gated UI detects refund + return-shipping
rows already sitting in imported `csv_import` transactions and routes them
through that same primitive instead of duplicating them.

## What already existed vs. what this adds

Two things this design leans on, both already shipped and unchanged:

- **`import_marketplace_csv`** (v16, not in this repo) tags imported rows with
  `source='csv_import'`, `platform`, `notes` = the marketplace order ref, and a
  `schedule_c_category` — `'payout'` for the sale/refund line, `'shipping_postage'`
  for label charges. This is the *only* place that classification happens; the
  reconciliation layer trusts it rather than re-parsing CSV shapes itself.
- **`sync_csv_orders_to_sales`** (v1) already nets refund rows into a *separate*,
  unlinked (`item_id: null`) synthetic `sales` row per order — computed
  `return_status`/`sale_price`, no FIFO. That path is fine as-is: those sales
  never had inventory allocated, so there's no lot to restore and no COGS
  overstatement risk. **This reconciliation layer is not about those rows** — it
  targets the *other* kind of sale: one recorded through `RecordSaleModal`
  (`record_sale`, `item_id` set, FIFO-depleted) whose real-world refund later
  shows up in an imported CSV, currently sitting unlinked with nothing tying it
  back to the sale or restoring the lot.

## Detection (`src/lib/csvReturns.ts`)

Pure function `buildCSVReturnCandidates(csvRows, sales)`, fetched by
`useCSVReturnCandidates(platform)`:

1. Group `csv_import` transactions (unlinked — `related_sale_id is null`) by
   `notes` (the order ref).
2. Within a group, a `schedule_c_category === 'payout'` row with `amount < 0`
   is a refund candidate.
3. **Return-shipping heuristic** — no platform reliably distinguishes an
   outbound label from a return label in the categories this app assigns on
   import. Per the parent design doc's fallback ("treat any post-sale label on
   a refunded order as return shipping"): the earliest `shipping_postage` row
   in the group dated **on or after** the refund's date is the candidate — an
   outbound label is bought at sale time, before any refund exists. A shared
   pool prevents two refunds in one group from both claiming the same
   shipping row.
4. Match to a sale by `external_order_id === orderRef`, restricted to
   inventory-linked (`item_id` set), non-deleted, non-trade, not-fully-returned
   sales. 0 matches → "unmatched" (nothing to apply to, shown but inert in the
   UI); 2+ → the review modal lets the user pick.

This is intentionally conservative: it only ever *surfaces* candidates. Nothing
mutates until a human picks "Apply Return" (see `docs/features/settings.md#return-reconciliation`
for the UI). No auto-apply, matching the parent doc's "review queue (proposed)"
choice and its stated rationale (multi-item orders share one order id; FIFO is
hard to undo if mis-matched).

## `record_return` / `reverse_return` contract change (v2)

Both accept the CSV path through two new optional params, exactly as the
parent doc specified:

- `refund_transaction_id`, `return_shipping_transaction_id` — when given,
  `record_return` **updates** those existing rows in place (`related_sale_id`
  set; the refund row's `schedule_c_category` flips `'payout' → 'returns_allowances'`;
  the shipping row's category doesn't change, it was already `'shipping_postage'`)
  instead of inserting new ones. Guards against double-apply: if either
  transaction already has `related_sale_id` set, 409.
- `returns.refund_transaction_id`/`return_shipping_transaction_id` (new
  columns, migration `20260827120000_csv_return_reconciliation.sql`) remember
  which rows were re-tagged, so `reverse_return`'s edit-flow reversal can
  **un-tag** exactly those rows (clear `related_sale_id`; restore the refund
  row's category to `'payout'`) instead of hard-deleting them — they're real
  imported bank/marketplace history, not synthetic rows this function created.
  The manual path (both columns null) is unchanged: insert-on-record,
  delete-on-reverse.

The FIFO reversal, sale-column updates, and quantity validation are identical
on both paths — only how the two transaction rows are produced/undone differs.

## UI

`ReturnReconciliationSection` (Settings → Marketplace CSV tab, below Settlement
Status) — segmented eBay/Amazon toggle, one row per detected candidate showing
order ref, refund amount, guessed return-shipping amount, and a match-count
badge (Review / N sales match / Unmatched). Clicking a row opens
`ReconcileReturnModal`: shows the matched transaction(s), a sale picker when
ambiguous, editable quantity/refund-amount/reason (same fields as the manual
`ProcessReturnModal`), and a checkbox to include/exclude the guessed
return-shipping row. Submits through `recordReturn(..., source: 'csv_import')`
— the same mutation wrapper the manual modal uses, extended with the two
transaction-id params.

## Deliberately out of scope (matches the parent doc's "Out of scope (v1)")

- Auto-apply without review.
- A manual sale-search picker for the "0 matches" case — those candidates show
  as unmatched with no action; re-categorizing the row away from `'payout'`/
  `'shipping_postage'` in Expenses is the escape hatch if a candidate is a
  false positive.
- Persistent per-candidate "dismiss" (no dismissed-state column) — the only way
  to make a candidate stop appearing is to apply it or recategorize the
  underlying transaction row so it no longer matches the detection query.
- Multiple sequential returns per sale (inherited limitation from the manual
  path).
- A unit-test spec for `buildCSVReturnCandidates` — not one of the three files
  with existing Vitest coverage (`saleProfit.ts`, `scheduleCMath.ts`,
  `categories.ts`); per `CLAUDE.md`, new spec files aren't added to uncovered
  areas unless asked.
