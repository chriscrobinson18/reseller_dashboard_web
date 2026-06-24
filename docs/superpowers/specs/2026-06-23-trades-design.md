# Trades — Barter Exchange of Inventory

**Status:** Draft — awaiting user review
**Date:** 2026-06-23
**Author:** Brainstormed with Claude

## Background

The user resells sports cards and frequently trades inventory for other inventory (e.g. 1 sealed box for 10 boxes of a different product). Trades may include cash boot in either direction. Today the app has no first-class support for trades — the user would have to manually fabricate a "sale" of one item and a "purchase" of another with no linkage and no non-cash handling, which corrupts both Schedule C (phantom cash) and per-item profitability.

This spec adds a `trades` first-class entity that records both sides of the barter, posts the correct Schedule C transactions (including a non-cash flag), and reuses the existing FIFO/profitability machinery.

## Accounting model (locked in — CPA-correct)

A barter exchange is a taxable event. Per IRS Pub 525 / Topic 420, **gross receipts equal the FMV of property received**. The §1031 like-kind exchange exemption no longer applies to personal property post-TCJA 2017, so trades are fully recognized in the year they occur.

### Anchor: the trade itself sets FMV

When two arms-length parties agree your box is worth $3,000 of their boxes, $3,000 *is* the FMV. Prior FMV estimates (e.g. $2,500 from sold comps) are not used as the transaction price — the trade price anchors. Better-than-comps execution is captured in gross profit, not booked twice.

### COGS-timing decision: deduct at acquisition (consistent with current app)

The app currently posts `cost_of_goods` transactions when inventory is purchased (cash basis, deduct at acquisition). Trades follow the same pattern: **the basis of received items is deducted at trade time**, not deferred until they sell. This avoids modifying the existing sale flow to post deferred COGS and keeps one mental model across all acquisitions (cash purchase, trade, box-opening).

Practical consequence: a future sale of a trade-acquired item generates revenue with no further COGS deduction at sale time. The full economic gain materializes over the lifecycle.

### Canonical Schedule C rule

For any trade with `given_FMV`, `received_FMV`, and signed `cash_boot` (positive = you received cash, negative = you paid cash):

| Component | Amount | `is_non_cash` |
|---|---|---|
| Non-cash income | `given_FMV − max(boot_received, 0)` | `true` |
| Non-cash COGS | same as non-cash income (always a wash) | `true` |
| Cash boot | `cash_boot` (signed; absent if 0) | `false` |

The two non-cash legs always wash each other. **The cash boot leg carries the entire Schedule C impact of the trade event.** If there's no boot, the trade is Schedule-C-neutral at the time it happens; the economic gain materializes later as received lots are sold.

### Worked examples

All examples assume Box A was previously bought for $2,000 cash and that $2,000 was already deducted as `cost_of_goods` at original purchase.

**Pure swap.** Give 1 box (FMV $2,500); receive 10 boxes (FMV $3,000); no cash.
Wait — this can't balance without boot. Per the FMV-anchor rule, the transaction price = received FMV = $3,000, so given_FMV is also recorded as $3,000 (you valued your box at $3,000 to make the deal). Pure swap means `given_FMV == received_FMV` (the trade itself sets both).
- Non-cash income: +$3,000
- Non-cash COGS: −$3,000
- Cash boot: none
- Net Schedule C from trade: $0
- New lots: 10 lots totaling $3,000 basis (allocated by line FMV)
- Future $5,000 sale of received boxes: +$5,000 revenue, no COGS. Total chain profit: $5,000 − $2,000 = $3,000. ✓

**Paid boot.** Give 1 box (FMV $2,500); receive 10 boxes (FMV $3,000); pay $500 cash.
- Non-cash income: +$2,500
- Non-cash COGS: −$2,500
- Cash boot: −$500 (`cost_of_goods` category, normal bank txn)
- Net Schedule C from trade: −$500
- New lots: 10 lots totaling $3,000 basis ($2,500 non-cash portion + $500 cash portion)
- Future $5,000 sale of received boxes: +$5,000 revenue, no COGS. Total chain profit: $5,000 − $2,000 − $500 = $2,500. ✓

**Received boot.** Give 1 box (FMV $3,000); receive 10 boxes (FMV $2,500) + $500 cash.
- Non-cash income: +$2,500 (= given_FMV $3,000 − boot_received $500)
- Non-cash COGS: −$2,500
- Cash boot: +$500 (`payout` category, normal bank txn)
- Net Schedule C from trade: +$500
- New lots: 10 lots totaling $2,500 basis (no cash portion — cash was received, not paid)
- Future $5,000 sale of received boxes: +$5,000 revenue, no COGS. Total chain profit: $5,000 − $2,000 + $500 = $3,500. ✓

### Profitability dashboard (independent of Schedule C timing)

Per-sale profitability reads from `inventory_movements.unit_cost`, not `transactions`. Both legs work correctly under this design:

- **Given-side sale:** `record_sale` FIFO-depletes the given item's lot; per-sale profit = `fmv − fifo_cogs`. For the example: $3,000 − $2,000 = $1,000.
- **Received-side future sale:** new lots have `unit_cost = allocated FMV`; future profit = `future_sale_price − allocated_fmv`.

No formula changes required.

## Data model

### New table: `trades`

One row per trade event.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | RLS-scoped |
| `created_at` | timestamptz | |
| `deleted_at` | timestamptz | soft-deleted |
| `traded_at` | date | drives Schedule C date |
| `counterparty` | text | nullable; "John D. on IG" / "@handle" |
| `given_fmv` | numeric | sum of given-side line FMVs (= what your stuff was "sold" for in the barter) |
| `received_fmv` | numeric | sum of received-side line FMVs (= total basis going onto new lots) |
| `cash_boot` | numeric | signed; `+` = you received cash, `−` = you paid cash, `0` = pure swap |
| `cash_transaction_id` | uuid FK | nullable; FK to the bank transaction for the boot (`ON DELETE SET NULL`) |
| `income_transaction_id` | uuid FK | non-cash `+` transaction (`ON DELETE SET NULL`) |
| `cogs_transaction_id` | uuid FK | non-cash `−` transaction (`ON DELETE SET NULL`) |
| `fmv_source_notes` | text | nullable; "eBay sold comps screenshot saved 2026-06-23" — IRS defensibility breadcrumb |
| `notes` | text | nullable |

**Invariants:**
- `given_fmv + max(cash_boot, 0)` ≈ `received_fmv + max(-cash_boot, 0)` (within $0.01) — both sides agree on transaction value
- Non-cash leg amount = `given_fmv − max(cash_boot, 0)`
- `cash_transaction_id` non-null iff `cash_boot ≠ 0`
- `income_transaction_id` and `cogs_transaction_id` always non-null

### Modified table: `sales`

| column | type | notes |
|---|---|---|
| `trade_id` | uuid FK | nullable; set on the sale(s) for items given up in the trade. `ON DELETE SET NULL`. |

`source` column: existing values `'manual' | 'csv_import' | 'plaid'` get a new value `'trade'`.

### Modified table: `inventory_lots`

| column | type | notes |
|---|---|---|
| `trade_id` | uuid FK | nullable; set on lots created from received-in-trade items. `ON DELETE SET NULL`. |

`transaction_id` on a trade-acquired lot points to the trade's `cogs_transaction_id` (so the existing "delete the source transaction → SET NULL on lots" behavior still works for the non-cash COGS transaction).

### Modified table: `transactions`

| column | type | notes |
|---|---|---|
| `is_non_cash` | boolean | default `false`. Marks trade-leg income and COGS transactions. Schedule C totals **include** these (they're real for tax); bank-reconciliation/cash-flow views exclude them. |
| `trade_id` | uuid FK | nullable; set on all transactions related to a trade (income, COGS, optional cash boot). `ON DELETE SET NULL`. |

## Mutation layer (`src/lib/mutations.ts`)

### New: `recordTrade`

```ts
export async function recordTrade(params: {
  tradedAt: string                    // 'yyyy-MM-dd'
  counterparty?: string | null
  notes?: string | null
  fmvSourceNotes?: string | null
  cashBoot: number                    // signed; + you received, − you paid, 0 pure swap
  given: Array<{
    itemId: string                    // must exist; lot picked FIFO
    quantity: number
    fmv: number                       // per-unit FMV at trade date
    platform?: string | null          // optional; defaults to 'trade'
  }>
  received: Array<{
    itemId?: string | null            // null = create new item
    newItemName?: string | null       // required if itemId null
    newItemCategory?: string | null
    quantity: number
    fmv: number                       // per-unit FMV at trade date (becomes lot unit_cost)
  }>
}): Promise<{
  tradeId: string
  saleIds: string[]                   // one per given line
  lotIds: string[]                    // one per received line
  incomeTransactionId: string
  cogsTransactionId: string
  cashTransactionId: string | null
}>
```

Steps (in order):

1. **Validate:**
   - `given` and `received` non-empty.
   - `given_fmv = Σ (given[].fmv × given[].quantity)`; `received_fmv = Σ (received[].fmv × received[].quantity)`.
   - Balance check: `given_fmv + max(-cashBoot, 0) ≈ received_fmv + max(cashBoot, 0)` (within $0.01).
   - All `given.itemId` exist, are owned by user, have sufficient `quantity_remaining` summed across lots.

2. **Insert `trades` row** (with `*_transaction_id` FKs null for now; back-fill in step 6).

3. **Create non-cash income transaction:** `amount = given_fmv − max(cashBoot, 0)`, category `payout`, `is_non_cash = true`, `trade_id`, merchant = counterparty or `"Trade"`, date = `tradedAt`, source = `'manual'`.

4. **Create non-cash COGS transaction:** `amount = -(given_fmv − max(cashBoot, 0))`, category `cost_of_goods`, `is_non_cash = true`, `trade_id`, merchant = counterparty or `"Trade"`, date = `tradedAt`, source = `'manual'`.

5. **If `cashBoot ≠ 0`, create bank transaction:**
   - `amount = cashBoot` (signed)
   - `category = 'payout'` if `cashBoot > 0`, else `'cost_of_goods'`
   - `is_non_cash = false`, `trade_id`, merchant = counterparty
   - source = `'manual'`

6. **Update `trades` row** with the three transaction IDs.

7. **For each `given` line:**
   - Invoke `record_sale` edge function: `item_id`, `quantity`, `sale_price = fmv × quantity` (line total — matches the existing `recordSale` convention where `salePrice` is the gross line amount), `platform = platform ?? 'trade'`, `sold_at = tradedAt + 'T12:00:00'` ISO, `source = 'trade'`, `external_order_id = null`.
   - After it returns `sale_id`, `.update({ trade_id, fees: 0, shipping_cost: null, net_payout: fmv × quantity })` on the sales row.
   - **Skip `createSaleTransactions`.** The trade's bundled income transaction (step 3) already covers gross receipts; calling `createSaleTransactions` would double-count.

8. **For each `received` line:**
   - Resolve item: if `itemId` is provided, use it directly; if null, create a new `items` row using `newItemName` (required) and `newItemCategory`. No find-by-name behavior.
   - Insert `inventory_lots` row: `quantity_purchased = quantity`, `quantity_remaining = quantity`, `unit_cost = fmv`, `transaction_id = cogsTransactionId`, `trade_id`.

9. Return ids.

**Failure handling (v1):** non-atomic; partial state left in DB on mid-flow failure. Surface error with `tradeId` if it was created; user manually invokes `deleteTrade` to clean up. v2 candidate: move to edge function with server-side transaction.

### New: `deleteTrade`

Soft-deletes the trade and reverses linked records.

1. **Abort guard:** if any received-side lot has `quantity_remaining < quantity_purchased` (i.e. has already been depleted by a sale), abort with error: `"Cannot delete trade — items received in this trade have already been sold."`
2. Hard-delete the three transactions (income, COGS, optional cash boot) — matches existing `deleteTransaction` hard-delete behavior for this table.
3. Soft-delete each given-side sale row (sets `deleted_at`).
4. Soft-delete each received-side lot (sets `deleted_at`).
5. Soft-delete the `trades` row.

**Inherited known issue:** soft-deleting a sale doesn't reverse FIFO depletion of `quantity_remaining` on the depleted lots (TASKS.md). Trade delete inherits this bug. Surface in the confirmation dialog ("Note: lots depleted by this trade's sales won't be restored — known issue") but don't fix in this spec.

### Out of scope: `updateTrade`

V1 edit flow is delete + re-record. The UI surfaces this as "Delete & re-record." v2 candidate.

### Existing mutations — no changes

- `recordSale` / `createSaleTransactions` — unchanged; `recordTrade` calls `record_sale` directly and skips `createSaleTransactions`.
- `deleteSale` / `deleteLot` — unchanged. UI hides direct delete/edit affordances on trade-linked rows (gate on `trade_id != null`); deletion routes through `deleteTrade`.
- `deleteTransaction` — unchanged. UI blocks direct deletion of trade-linked transactions and routes to the trade.

## UI

### Entry point

`src/pages/InventoryPage.tsx` — add **"Record Trade"** button in the top-right action row, alongside existing "Add Item".

### New modal: `RecordTradeModal` (`src/components/modals/RecordTradeModal.tsx`)

Single-step modal using the existing `Modal` primitive (wider than `SlideOver`).

**Header**
- Trade date (defaults to today)
- Counterparty (free text, optional)
- FMV source notes (optional) — hint text: "e.g. 'eBay sold comps saved'. Recommended for IRS defensibility."
- Notes (optional)

**Section: "You gave"**
- Repeating row:
  - Item: `ItemPicker`, constrained to items with `quantity_remaining > 0` summed across non-deleted lots
  - Quantity (default 1)
  - FMV per unit ($) — required
  - Line FMV (read-only computed): `qty × fmv`
- "+ Add line" button
- Subtotal: `given_fmv`

**Section: "You received"**
- Repeating row:
  - Item: `ItemPicker` with inline "+ Create new item" affordance (reuse box-opening pattern)
  - Quantity (default 1)
  - FMV per unit ($) — required (becomes lot `unit_cost`)
  - Line FMV (read-only computed): `qty × fmv`
- "+ Add line" button
- Subtotal: `received_fmv`

**Section: "Cash boot"** (collapsed by default)
- Toggle: "Cash changed hands?" → expands:
  - Direction (segmented control): "I paid" / "I received"
  - Amount ($)

**Footer — live balance**
- Display: `Given $X + Paid $Y  =  Received $Z + Received cash $W`
- Green check when balanced (within $0.01); red warning with specific delta otherwise
- "Record trade" submit button disabled until balanced and both sides non-empty

**Validation messages**
- Empty given side: "Add at least one item you're giving up"
- Empty received side: "Add at least one item you're receiving"
- Given line with insufficient inventory: "Only N available"
- Imbalance: `"Trade is off by $X — add a cash boot or adjust an FMV"`

### Inventory page — trade-acquired lot marker

Lots with `trade_id != null` display a small **"Trade"** pill in the lot list (same visual treatment as the planned "Box open" pill from the sibling spec). Click pill → opens Trade detail.

### Sales page — given-side sale row marker

Sales with `trade_id != null` display a **"Trade"** pill in the platform/source column (in place of "Manual"). Click pill → opens Trade detail.

### New view: `TradeDetailSlideOver` (`src/components/TradeDetailSlideOver.tsx`)

Read-only `SlideOver` (drawer pattern, matches existing read-only details).

Shows:
- Trade date, counterparty, FMV source notes, notes
- **Given side:** list of `(item, qty, FMV, line total)`; each row links to its `Sale` detail
- **Received side:** list of `(item, qty, FMV, line total)`; each row links to inventory item
- **Cash boot** (if any): direction, amount, link to bank transaction
- **Linked transactions:** three rows (income, COGS, cash boot if present) each clickable
- **Delete trade** button → `ConfirmDialog` with:
  - Lifecycle warning: "This will delete the trade and reverse the income, COGS, and (if any) cash boot transactions, plus soft-delete the linked sales and lots."
  - FIFO inherited-issue warning: "Lots that were depleted by this trade's sales won't be automatically restored (known issue)."
  - Disabled if any received lot has been depleted, with explanatory tooltip
- **No edit button in v1** (delete + re-record)

### Transactions page — non-cash badge

Transactions with `is_non_cash = true` get a "non-cash" badge in the list. In transaction detail:
- Banner: "This is a non-cash transaction from a trade. Edit/delete it from the trade."
- "Open trade" link
- Edit/delete buttons disabled

### Dashboard — no UI changes

`computeScheduleC`, `computeKPIs`, `computeMonthlyChart` already sum `transactions.amount` respecting category. Non-cash trade transactions are real Schedule C inputs and should be included — no filter changes needed.

If a future bank-balance or cash-flow view is added, it should filter on `is_non_cash = false`. (Not in scope here; flagged for whoever adds such a view.)

## Edge cases

- **FMV of $0 on a line:** allowed (freebie thrown in). Lot gets `unit_cost = 0`.
- **Same item on both sides:** allowed (rare — duplicate-for-upgrade). Given depletes existing lot; received creates a new lot.
- **Soft-deleted items:** filtered out of both ItemPickers.
- **Given quantity > available:** validation blocks at submit; trades cannot oversell.

## Out of scope (v1)

- **Editing a trade** — delete + re-record only.
- **Trades involving services** (e.g. trading cards for grading labor) — IRS treats as barter at FMV but no service line type.
- **Trades involving non-inventory property** (vehicles, personal items) — this is a reseller-inventory feature.
- **Marketplace credit or gift cards as boot** — only real cash boot. Marketplace credit is non-cash and would need its own asset modeling.
- **Auto-FMV lookup** (eBay/TCGplayer API) — manual entry only.
- **Bulk trade CSV import** — manual entry only.
- **Server-side atomicity** — client-orchestrated v1; partial-failure recovery is manual `deleteTrade`.
- **FIFO reversal on trade delete** — inherits TASKS.md bug; surfaced but not fixed.
- **Cross-client (iOS) UI parity** — schema is additive and won't break iOS; no iOS UI in this scope.
- **Multi-currency / non-USD trades.**

## Documentation updates (same PR)

Per `CLAUDE.md` doc-maintenance rule:

- **`docs/supabase-schema.md`** — document new `trades` table; new columns `sales.trade_id`, `inventory_lots.trade_id`, `transactions.is_non_cash`, `transactions.trade_id`; new `sales.source = 'trade'` value.
- **`docs/data-flows.md`** — add "Recording a trade" section with the canonical-rule tally table and all three worked examples (pure swap, paid boot, received boot).
- **`docs/features/inventory.md`** — document the Record Trade flow, trade-acquired lot pill, trade detail slide-over.
- **`docs/features/sales.md`** — document trade-leg sale pill and that trade-linked sales aren't directly editable.
- **`docs/categories.md`** — note that `payout` and `cost_of_goods` totals may include non-cash trade legs; both are correct Schedule C inputs.
- **`TASKS.md`** — add v2 follow-ups (atomic edge function for `recordTrade`; FIFO reversal on trade/sale delete; `updateTrade`).

## Open questions for user review

1. **Item picker scope for "given" side:** spec restricts to items with `quantity_remaining > 0`. Acceptable, or allow giving away an oversold item (matching how the existing oversold sale flow works)?
2. **Default platform for given-side sales:** spec uses `'trade'`. Acceptable, or use counterparty name, or leave null?
3. **FMV source notes:** required, recommended, or fully optional? Spec has it as optional with a hint. CPA-defensibility argues for "recommended" (UI nudge) but not blocking.
4. **Trade detail surface:** `SlideOver` chosen over `Modal` for the read-only drawer feel. Right call, or should it be a full page like sale detail?
5. **`deleteTrade` abort threshold:** spec aborts if **any** received lot has been even partially depleted. Acceptable strictness, or should it allow delete with a warning if depletions are reversible (which they're currently not, per the inherited bug)?

## Success criteria

- User records a 1→10 trade (pure swap, FMV $3,000): one `trades` row, one given-side sale, 10 received-side lots, `+$3,000 / −$3,000` non-cash transactions, no cash transaction, $0 net Schedule C from the trade event. Given-side sale shows `$3,000 − $2,000 = $1,000` profit on the Profitability card.
- Paid-boot trade ($500 cash out): cash transaction `−$500` with `is_non_cash = false`, category `cost_of_goods`. Non-cash legs `±$2,500`. Net Schedule C from trade = `−$500`.
- Received-boot trade ($500 cash in): cash transaction `+$500` with `is_non_cash = false`, category `payout`. Non-cash legs `±$2,500`. Net Schedule C from trade = `+$500`.
- Future sales of trade-acquired lots use existing `record_sale` flow with no special-casing; FIFO depletion and profitability calculations work as-is.
- `deleteTrade` reverses all three transactions, soft-deletes sales and lots, and aborts cleanly if any received lot has been depleted.
- Hand-tally of a sample trade matches the canonical rule table in this spec.
- All `docs/` files above updated in the same PR.
