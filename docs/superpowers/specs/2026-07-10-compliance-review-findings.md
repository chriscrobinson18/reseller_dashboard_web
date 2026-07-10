# Compliance Review — Ledger, FIFO Inventory & Schedule C Output

**Status:** Findings — awaiting triage into TASKS.md priority tiers (partially triaged in this same change; see cross-references below)
**Date:** 2026-07-10
**Author:** CPA-lens review with Claude, plus an owner's-lens pass against the actual business (online arbitrage, thrift/Facebook flipping, sports/TCG cards — box breaking, raw-card grading, sealed-product holding — sold across FB Marketplace, eBay, Amazon, TCGPlayer; majority category is Collectibles)

## Scope & method

Reviewed the core bookkeeping ledger, FIFO cost-lot inventory, and Schedule C computation pipeline by hand-tracing money and quantity through every mutation path against IRS Schedule C mechanics (Part I gross receipts, Part II expense lines, Part III COGS, the 50% meals limitation, barter/FMV income under IRC §1001) — not a static lint pass. Files read: `src/lib/categories.ts`, `scheduleCMath.ts`, `saleProfit.ts`, `mutations.ts`, `DashboardPage.tsx`; edge functions `record_sale`, `record_return`, `reverse_sale`; migration `20260623120000_reverse_sale_rpc.sql`; sale/lot input modals; all of `docs/`.

Explicitly out of scope: Plaid, CSV import UI, marketplace OAuth, receipts — already tracked as roadmap items in `TASKS.md` and not part of this review's brief (core ledger/inventory/Schedule C only).

## What's already correct (no action needed)

- **Signed-amount bucketing** (`bucketTransaction`, `categories.ts:154–176`) — refunds posted to an expense category reduce it rather than inflating both income and expenses. This is the exact bug class the 2026-06-23 P0 pass closed, and it's still closed.
- **Meals 50% limitation** isolated to one flag (`mealsHalf`), applied once inside `bucketTransaction`; custom categories can only inherit it via `parent_value: 'meals'` — `Line 24b` direct mapping is explicitly disallowed (`categories.ts:738`).
- **FIFO COGS via audit trail**, never weighted average — `saleProfit.ts:19–22` sums `inventory_movements.quantity × lot.unit_cost`. The Inventory page's weighted-average cost is display-only and never enters a COGS calc.
- **`reverse_sale` is atomic and race-safe** — single Postgres transaction, `FOR UPDATE` locks on the sale row and every affected lot, ownership check, replay guard (`already_deleted`). This is the standard the rest of the mutation surface should be held to (see F-01/F-02 below).
- **Barter/trade accounting** — three worked examples (pure swap, paid boot, received boot) all reconcile; cash boot correctly carries the entire Schedule C impact while non-cash legs wash. Matches IRC §1001 treatment.
- **Full returns excluded from revenue entirely** (`DashboardPage.tsx:53`), not netted to a phantom $0 row.
- **RLS-scoped writes** — every insert path checked in `mutations.ts` resolves and sets `user_id` explicitly via `getUserId()`.

## Findings (new, not previously in TASKS.md)

Ordered by severity, then by centrality to Schedule C output. Each cites the file:line it was found at.

### F-01 [High] — FIFO depletion has no row locking; concurrent sales can corrupt cost basis
`supabase/functions/record_sale/index.ts:96–131`. Reads lots, then loops plain `UPDATE`s with no lock between read and write. Two sales for the same item close together (double-click, two tabs, or a future Plaid/CSV sync racing a manual entry) can both read the same `quantity_remaining` and each write based on a stale value — double-depleting a lot or desyncing `inventory_movements` from what actually left stock, which means COGS on either sale is no longer trustworthy. Notably, `reverse_sale`'s own migration comment says it locks lot rows specifically to "serialize this RPC against a concurrent `record_sale`" — that fixes one side of the race (delete vs. sale) but not the far more common side (sale vs. sale).
**Fix:** move depletion into a `SECURITY DEFINER` RPC using `SELECT … FOR UPDATE` on candidate lots, mirroring `reverse_sale`'s pattern exactly.

### F-02 [High] — Return processing is six unguarded REST calls, not a transaction
`supabase/functions/record_return/index.ts:78–191`. Insert return → update sale → read movements → loop read/update lots → delete/shrink movements → insert refund transaction — six sequential, independently-committing calls, no transaction, no locks, no replay guard (unlike `reverse_sale`'s `already_deleted` check). A failure partway through — e.g. inventory restored and `return_status` flipped but the refund transaction row never inserted — leaves Part I overstated by the refunded amount with no way to detect it, and a retry can double-restore inventory.
**Fix:** same treatment as `reverse_sale` — one RPC, one transaction, `FOR UPDATE` locks, idempotency guard.

### F-03 [Medium] — Editing a sale's quantity detaches it from its own FIFO trail
`src/components/modals/EditSaleModal.tsx:76–78`, `src/lib/mutations.ts:325–375` (`updateSale`). The quantity field is editable on an existing sale; `updateSale()` patches `sales.quantity` and the linked payout/fee/shipping transaction amounts but never touches `inventory_movements`/`inventory_lots.quantity_remaining`. A sale recorded for 2 units (FIFO-depletes 2, COGS = 2 units) later corrected to 5 units leaves `sales.quantity = 5` with revenue for 5 units, but only 2 units' cost basis exists — inventory is overstated by 3 units and gross profit is inflated by their cost.
**Fix:** remove quantity from editable fields on manual sales (force delete + re-record, which gets full FIFO treatment), or extend `updateSale` to diff and run the delta through the same locked RPC path as F-01/F-02.

### F-04 [Medium] — A broken custom-category mapping vanishes from the Schedule C breakdown but still counts in the KPI total
`src/lib/categories.ts:95–132` (`resolveCategory`); `custom_categories.parent_value` has no DB-level referential integrity, only client-side validation against the in-memory `CATEGORIES` array at creation time. If a built-in value is ever renamed/removed, or the independently-ported iOS copy of `categories.ts` drifts from web's, a custom category's parent can resolve to nothing. Traced through `bucketTransaction`, the transaction still lands in the generic `'expense'` bucket and its dollar amount is still summed into the Total Expenses KPI and `computeScheduleC`'s totals object — but the Dashboard's Part II breakdown drops any custom category that resolves to `undefined`, so that same dollar amount never appears as an itemized line. **The KPI total and the sum of its own itemized breakdown silently stop tying to each other.**
**Fix:** DB-level allowlist check on `parent_value`, plus render an explicit "Unmapped category" line for any dollar amount present in `computeScheduleC` but absent from the resolved category list, instead of letting it disappear.

### F-05 [Medium] — No audit trail on transaction edits or deletes
`src/lib/mutations.ts:143–181`. `transactions` is the one core table without `deleted_at` — deletes are permanent, and edits to amount/date/category overwrite in place with no history. Not about blocking corrections (bookkeeping requires them); it's that once a transaction has informed a number the user already relied on, there's no way to reconstruct what it looked like before.
**Fix:** soft-delete `transactions` (matching every other table), add a lightweight history table (or trigger) capturing prior `amount`/`date`/`schedule_c_category` on `UPDATE`/`DELETE`.

### F-06 [Low] — No period lock for filed tax years
No control anywhere prevents editing a record dated in an already-filed tax year. Pairs with the planned `tax_profiles` table (P2) — add a "lock entries before this date" setting.

### F-07 [Low] — No shared cents-rounding boundary in client-side aggregation
`src/lib/scheduleCMath.ts`, `DashboardPage.tsx:52–66`. All aggregation sums native JS floats with no rounding step before display; two totals computed two different ways from the same rows can in principle differ by a sub-cent amount that display rounding turns into a visible 1¢ mismatch. Low likelihood, but a bookkeeping tool's core promise is that the numbers tie out exactly.
**Fix:** round to cents at each aggregation boundary, or move to an integer-cents convention client-side.

### F-08 [Low] — Nothing gates a "final" number on data completeness
`categories.ts:161` (uncategorized → `null` bucket, silently excluded forever); no banner exists for oversold sales at all. Ties directly to the planned Schedule C export (P1): require zero uncategorized transactions (or an explicit "export anyway, N excluded" acknowledgement) before producing a filing-ready number.

## Owner's-lens findings (business-fit, not pure tax-math)

Reviewed against the actual operation: box breaks, raw-card grading, sealed-product holding, FB Marketplace + eBay + Amazon + TCGPlayer as sale channels, majority-Collectibles category mix.

### Already well-suited to this business
- Barter/trade accounting (rare in bookkeeping tools; right for a card trader — `fmv_source_notes` gives FMV documentation for volatile singles).
- FIFO lots map cleanly to sealed-case purchases.
- Oversold flagging matches "sell before the box arrives" behavior.
- One-off thrift flips (unique item, qty-1 lot, single sale) work end-to-end today.

### Box breaking and grading capitalization — **already fully designed, not yet built, not yet tracked**
A complete, CPA-approved spec for exactly these two workflows already exists at [`2026-06-23-box-opening-and-grading-design.md`](2026-06-23-box-opening-and-grading-design.md) — NIMS (§471(c)(1)(B)(ii)) inventory method, relative-FMV allocation for box breaks (`box_openings` table), capitalized grading fees via `lot_cost_adjustments`. It is materially better-reasoned than a fresh proposal would be (specific-identification fallback, an explicit `unit_cost` recomputation invariant, a full worked-example success criteria section). Its status is `Draft — awaiting user review` and it was never linked into `TASKS.md`, so it has been sitting unactioned since 2026-06-23 despite covering this business's two highest-value missing workflows.
**Given the majority-Collectibles category, this should be treated as a build priority, not background research.** See TASKS.md P1 cross-reference below. Nothing further to design here — the open items are the 5 "Open questions for user review" already listed at the bottom of that spec.

### O-01 [Medium] — Personal-use withdrawal (Line 36) has no operation
Already flagged in `TASKS.md`'s "Schema/Architecture Notes" as a background schema gap; elevated here because pulling cards for a personal collection is a weekly event in this business, not an edge case. Schedule C Line 36 requires purchases to be reduced by the cost of items withdrawn for personal use. Today the only workaround — deleting or shrinking the lot — leaves the original purchase fully deducted as COGS with nothing subtracting the withdrawn basis, overstating COGS by the kept cards' cost. The withdrawn card's basis also needs to travel with it (it becomes a personal capital asset; its documented cost matters if it's ever sold).
**Fix:** a "withdraw for personal use" adjustment — same shape as the box-opening spec's `lot_cost_adjustments` pattern, but reducing rather than adding basis, and reducing `quantity_remaining`/COGS accordingly. Natural to design as a companion to that spec rather than standalone.

### O-02 [Medium] — Facebook Marketplace isn't in the platform list
`src/components/modals/RecordSaleModal.tsx:10`, `EditSaleModal.tsx:8`. The platform dropdown (`ebay, amazon, tcgplayer, mercari, stockx, goat, whatnot, manual`) is missing one of this business's two highest-volume channels — every FB sale gets filed under `manual`, poisoning per-platform profitability and any future 1099-K-by-platform reconciliation. One-line fix. The deeper point: FB local-cash sales generate no 1099-K, so income completeness for that channel rests entirely on entry happening at all — recording a $40 cash flip should be a ten-second interaction, not the full multi-field modal.

### O-03 [Medium] — No multi-item order entry
`supabase/functions/record_sale/index.ts:52–70` — one `item_id` per sale. "Take the whole pile for $100" (FB/card-show) and bundled eBay/TCGPlayer orders both need hand-split prices and hand-split fees across many manual sale entries today, with nothing enforcing that the splits sum to what was actually received or that a shared order fee isn't double-entered.

## Confirmed still-open items from the existing audit trail

Re-verified against current code rather than re-derived; listed so the backlog below can reference them without duplicating credit.

| Gap | Confirmed impact | Source |
|---|---|---|
| Returns & Allowances not split out on Part I | Refund rows correctly reduce Line 1 in the math today; UI still nets them into `payout` instead of showing Gross Receipts − Returns = Line 1 — 1099-K mismatch risk | TASKS.md P0 item 4 |
| Part III inventory valuation lives nowhere | No `inventory_valuations` table; Beginning/Ending Inventory has no server-side home | TASKS.md P2 |
| No `sales_tax` column | Can't prove Line 1 excludes pass-through sales tax | docs/supabase-schema.md |
| No `purchase_date` on lots | Back-dated purchase entries sort by data-entry time, not purchase date — FIFO can consume the wrong lot | TASKS.md Schema Notes |
| No `quantity` on `transactions` | Multi-unit CSV sales hardcode `quantity: 1` | TASKS.md Schema Notes |
| No Schedule C Summary export | The one-row-per-IRS-line "form" output doesn't exist on either client | TASKS.md P1 |

## Additional finding surfaced while drafting the settlement design (see companion spec)

### F-09 [High] — Schedule C breakdown excludes all recorded-sale revenue and fees today, by design
Traced through `bucketTransaction`: any transaction with `related_sale_id` set returns the `null` bucket unconditionally (`categories.ts:158`). The payout/fee/shipping rows `createSaleTransactions` creates for every manually-recorded sale are *all* `related_sale_id`-tagged. That means **`computeScheduleC`'s Part I never includes sale revenue, and Part II Line 10/27a never include sale fees/shipping**, for any user recording sales manually — the only place that revenue currently appears is the separate Sales Profitability card (`computeProfitability`). The documented rationale (`data-flows.md` "why related_sale_id / csv_import are excluded") assumes a bank-deposit transaction, categorized `payout`, will eventually carry that income once Plaid ships — but **that deposit-side transaction doesn't exist yet for anyone on manual entry**, so today the Dashboard's headline "Schedule C Breakdown" widget silently omits real, already-recorded revenue. See the companion settlement-reconciliation spec for the recommended fix (flip the convention: itemized sale-linked rows count, platform deposits get marked `settlement` and excluded).

## Requirements backlog (cross-referenced into TASKS.md in this same change)

| ID | Title | Tier | Source |
|---|---|---|---|
| REQ-01 | Lock inventory rows during FIFO depletion (`record_sale` → RPC) | P0 | F-01 |
| REQ-02 | Make return processing atomic + replay-safe (`record_return` → RPC) | P0 | F-02 |
| REQ-03 | Show Returns & Allowances as explicit Part I subtraction | P0 | tracked, TASKS.md P0 item 4 |
| REQ-04 | Reconcile sale-quantity edits with FIFO inventory | P0 | F-03 |
| REQ-05 | Ship Box Opening & Grading (existing spec, un-triaged) | P1 | already designed — see above |
| REQ-06 | Personal-use withdrawal adjustment (Line 36) | P1 | O-01 |
| REQ-07 | Facebook Marketplace platform + fast cash-sale entry | P1 | O-02 |
| REQ-08 | Multi-item order entry with enforced allocation | P1/P2 | O-03 |
| REQ-09 | Settlement/disbursement reconciliation + flip deposit-vs-itemized convention | P1 | F-09, companion spec |
| REQ-10 | Schedule C Summary export | P1 | tracked, TASKS.md P1 |
| REQ-11 | Beginning/Ending inventory stored server-side, full tax year | P1 (elevated from P2) | tracked, TASKS.md P2 — elevated: user holds sealed product across year-end as strategy |
| REQ-12 | `sales_tax` column + Line 1 exclusion proof | P1 | tracked, schema gap |
| REQ-13 | `purchase_date` on lots | P1 | tracked, schema gap — exposure is this owner's normal entry pattern (batch-entered thrift/card-show hauls), not occasional |
| REQ-14 | `quantity` column on `transactions` | P1 | tracked, schema gap |
| REQ-15 | Soft-delete transactions + change history | P1 | F-05 |
| REQ-16 | Custom-category integrity guard + "unmapped" reconciliation line | P1 | F-04 |
| REQ-17 | 1099-K reconciliation by platform | P2 (elevated from lower priority) | tracked, TASKS.md P2 — elevated: 4 channels, 3 issue 1099-Ks at this volume |
| REQ-18 | Period lock for filed tax years | P2 | F-06 |
| REQ-19 | Cents-rounding discipline at aggregation boundaries | P2 | F-07 |
| REQ-20 | Gate export/"final" output on data completeness (uncategorized + oversold) | P2 | F-08 |

See `TASKS.md` for these triaged into the existing priority sections, and [`2026-07-10-settlement-reconciliation-design.md`](2026-07-10-settlement-reconciliation-design.md) for REQ-09's full design.
