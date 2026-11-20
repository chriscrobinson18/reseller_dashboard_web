# Expenses (`src/pages/ExpensesPage.tsx`)

Transaction list + editing surface. The only page where `transactions` rows are directly created/edited/deleted/categorized.

## List view

- Fetches via local `fetchTransactions(start, end)` (same shape as Dashboard's copy, separately defined — see [architecture.md](../architecture.md)).
- **Toolbar layout** (2026-11-20), in three layers: (1) date presets (`PeriodPicker`); (2) a full-width search box (on phones, with the Filters toggle beside it); (3) the remaining filters, which wrap onto more lines as needed: category, direction, source, account, inventory, review, Sale rows, Net-zero rows, and the Transactions / Net-zero pairs view switch. **Add** sits in the header next to the in/out totals.
- Client-side filters (all `useMemo`'d together): text search over `transactionHaystack(t, customs)` (see below), category dropdown filter (exact match on `schedule_c_category`), direction filter (income/expense), source filter (Plaid/manual), a per-account `<select>` (options derived from `plaid_account_id`/`account_display` pairs seen in the current period; auto-cleared if the selected account has no rows left after a period change), and a "Sale rows" toggle (`showSaleLinked`) that by default **hides** rows where `related_sale_id` is set or `source === 'csv_import'` — these are the auto-created payout/fee/shipping rows from `recordSale` (see [data-flows.md](../data-flows.md)).
- **Sort** (added 2026-08-27): Date / Merchant / Amount column headers are clickable — click toggles direction, clicking a different column switches to it (default desc for Date/Amount, asc for Merchant). Purely a client-side re-order of the already-filtered rows (`sorted`, a separate `useMemo` from `filtered`) — it doesn't affect the server query, the header/uncategorized counts, or bulk-selection reset (sort isn't part of `filterSig`, since re-ordering the same rows doesn't need to clear a selection). Amount sorts by the raw signed value, not magnitude, so ascending runs from the largest expense to the largest income.
- Header shows live `income`/`expenses` totals for the *filtered* set (not the exclusion-filtered "business" total Dashboard uses — these are simpler: any positive amount vs. any negative amount in the visible rows) plus an uncategorized-count badge computed from the *unfiltered* period set.
- Inline category change: clicking the `CategoryBadge` in a row opens the shared [`CategoryDropdown`](../../src/components/CategoryDropdown.tsx), a fixed-position popover positioned via CSS vars (`--dd-top`/`--dd-left`) set from the clicked element's bounding rect — not a `<select>`. Mutates via local `updateCategory`, invalidates `['transactions']`.

### Bulk categorize

- A leading checkbox column plus a header select-all lets the user multi-select rows. Trade-linked rows (`tx.trade_id`) have a disabled checkbox and are excluded from select-all — their category is locked (edited via the trade). Plaid rows are selectable (category is editable for them).
- **Shift-click range select (2026-11-20):** shift-click a row's checkbox to apply that row's new state (select or clear) to every row between it and the previously clicked checkbox, in the current sort/filter order (`selectRange` in `src/lib/utils.ts`). Trade-linked rows are skipped. The anchor resets whenever the filters change; with no anchor a shift-click is a plain toggle.
- When ≥1 row is selected, a floating dark pill bar appears at the bottom of the list: "N selected", a **Set category** dropdown (the same shared `CategoryDropdown`, so custom categories and "Clear category" both work), and a clear-selection ✕.
- Applying a category runs `bulkUpdateCategory(ids, cat)` — a single `.update({ schedule_c_category }).in('id', ids)` round-trip (not N requests) — then invalidates `['transactions']` and clears the selection.
- Selection is reset whenever the visible set changes (period / search / category filter / Sale-rows toggle) via a render-phase previous-signature check, so a bulk action can never silently hit rows the user can no longer see.

### Search

Lives in [`src/lib/transactionSearch.ts`](../../src/lib/transactionSearch.ts) — shared with the Inventory page's lot-funding picker, so both search boxes behave identically. `transactionHaystack(t, customs)` flattens every user-visible detail of a transaction into one lowercase string, which `parseSearchTerms` + `matchesSearch` substring-match. **Performance (2026-11-20):**
- The Expenses page builds every row's haystack once per data load (`buildSearchIndex`) and filters with `matchesTerms`. On about 4,700 rows that is roughly 0.7 ms per keystroke, down from roughly 800 ms.
- The query is passed through `useDeferredValue`, so the input never waits on the list, which fades while it catches up.
- The list draws 200 rows at first and loads the next 200 automatically as you near the bottom. An invisible marker under the list (`LoadMoreSentinel`, `IntersectionObserver` with an 800px margin) triggers it in both the phone and desktop scroll areas, and a "load now" button stays as a fallback. The footer shows "showing N" until everything is drawn. The filter totals, select-all and shift-click still use every matching row.
- `formatUSD` and the date formatters in `utils.ts` reuse module-level `Intl` formatters instead of building one per call, which speeds up every page. Covered: merchant, notes, resolved category label (built-in *and* custom) or the literal `uncategorized`, type, source, platform, account display, record type, amount, date, `expense`/`income`, `pending`, and the Plaid enrichment fields (website, city, region, payment channel, plaid category).

Two deliberate behaviors:

- **Amounts are indexed in several shapes** — `123.40`, `$123.40`, and `123.4` — and the query has `$` and `,` stripped from each term, so `$1,234.56` and `1234.56` both hit the same row. The sign is dropped; people search the magnitude on the receipt, not `-123.40`. Dates are indexed both ISO (`2026-05-15`) and display (`May 15, 2026`).
- **Whitespace splits into terms that must ALL match**, so `ebay 140` narrows to eBay rows around $140 instead of unioning the two. The terms match independently anywhere in the haystack, so multi-word queries are a narrowing heuristic, not a phrase match — `may 15, 2026` matches any row containing all three tokens somewhere, not only rows dated May 15.

### Detail panel state

The page stores only `selectedId`, never a `Transaction` snapshot; the panel's `tx` is derived with `transactions.find(t => t.id === selectedId)`. This matters — holding the object captured at row-click time meant a category/notes/field edit refetched the list but left the open panel rendering the pre-edit values until it was closed and reopened.

Two consequences of deriving it:

- Resolution runs against the **unfiltered** `transactions`, not `filtered`, so recategorizing a row that the active category filter then excludes doesn't yank the panel shut mid-edit.
- A deleted transaction drops out of the array, so `selected` becomes `null` and the panel closes on its own.

Because `tx` now changes identity on refetch (the component doesn't remount — `key` is still the id), the inline edit fields are re-seeded from `tx` when **Edit** is opened rather than only at mount, so they can't show values that went stale while the panel sat open.

### Category dropdowns (shared)

Every category picker on this page (top-of-page filter, inline category cell, detail-pane dropdown) renders the shared `CategoryDropdown` component with four sections:

- **Your categories** — user-defined customs (active only, sorted by name)
- **Schedule C** — built-in non-excluded categories
- **Other** — excluded built-ins (Transfer, Personal, Settlement, Balance Adjustment)
- **⚙ Manage categories…** footer — opens `ManageCategoriesModal` for CRUD on custom categories

The same dropdown is also used by [`AddTransactionModal`](../../src/components/modals/AddTransactionModal.tsx). Deleted custom categories don't appear in pickers but historical transactions tagged with them still render as `"Name (deleted)"` and continue to roll up to their resolved `scheduleLine` in the Dashboard Schedule C breakdown — see [`docs/categories.md`](../categories.md#custom-categories-shipped-2026-06-25).

### Manage Categories modal

[`ManageCategoriesModal`](../../src/components/modals/ManageCategoriesModal.tsx) (opened via the dropdown's "Manage categories…" footer) is the single CRUD surface for custom categories. Two things worth noting:

- **In-modal help.** An `InfoPopover` in the modal header explains the two mapping modes (`Refine an existing category` vs. `Map to a Schedule C line directly`), tombstone behavior, and why Line 24b is excluded from the explicit-line picker. Pattern matches the trades modal.
- **Friendly line labels in the explicit-line picker.** The `<select>` shows `"Office Expense (Line 18)"`, `"Utilities (Line 25)"`, `"Income / Gross Receipts (Part I)"`, etc. — never raw `"Line 18"` / `"Part I"`. Labels come from `describeScheduleLine()` in `src/lib/categories.ts`. If you add another category-picker surface that exposes Schedule C line choices, route it through the same helper so the language stays consistent.

## Auto-categorization on Plaid sync

`plaid_sync_transactions` stamps a category on newly synced, still-uncategorized rows (`record_type = 'transaction'`) using Plaid's primary `personal_finance_category` (`PFC_TO_SCHEDULE_C` in `supabase/functions/plaid_sync_transactions/index.ts`):

| Plaid primary | → category |
|---|---|
| `TRANSFER_IN`, `TRANSFER_OUT`, `LOAN_PAYMENTS` | `transfer` (excluded from Schedule C) |
| `INCOME` | `payout` |
| `BANK_FEES` | `other_expense` |
| `FOOD_AND_DRINK` | `meals` |
| `TRAVEL` | `travel` |
| `RENT_AND_UTILITIES` | `utilities` |
| `PERSONAL_CARE`, `MEDICAL` | `personal` |

Before this runs, `classifySettlement` marks incoming deposits as `record_type = 'settlement'` (category `settlement`, excluded). **Only credits on deposit accounts qualify** (Plaid account `type = 'depository'` with subtype `checking`, `savings`, `money market` or `cash management`; since 2026-11-09, `plaid_sync_transactions` deploy v47 and `plaid_sync_scheduled` deploy v27, which share `_shared/plaidSync.ts`). A credit on a credit card from the same merchants (an eBay, Amazon or PayPal refund of a purchase) is **not** a settlement: it goes through category rules and the PFC map like any card row, so the refund nets against the purchase category instead of vanishing from Schedule C. Qualifying sources: marketplace payouts (eBay, Amazon, TCGplayer, Mercari, StockX, GOAT, Poshmark, Depop) and, since 2026-11-09, **wallet cash-outs** (PayPal and Cash App → bank, `platform` = `paypal` / `cashapp`; Venmo is personal-only by policy, so it stays `transfer`). The model is the same as eBay: income is recognized from the recorded **sale**, and the bank deposit is just the money arriving. It's only complete if every P2P sale is recorded in Sales. Incoming **Zelle** is deliberately left out (a direct buyer payment with no wallet in between); it still falls to `TRANSFER_IN → transfer`. A per-channel deposits-vs-recorded-sales reconciliation is the planned check for unrecorded P2P income. The pass only fills `NULL` categories, so manual edits are never overwritten. `LOAN_PAYMENTS` was added 2026-11-09: credit-card payments had been left uncategorized because they have no `merchant_entity_id` for category rules to key off. **Caveat:** blanket `TRANSFER_IN → transfer` can hide real income that arrives as a transfer (P2P business payments, some marketplace payouts). Re-tag those to Payout by hand.

## Detail panel (`TransactionDetail`, inside a `SlideOver`)

- **Plaid-sourced transactions** (`source === 'plaid'`) are read-only except category and notes — no Edit button, edit-mode amount/date/merchant fields don't render. Delete still works (removes the row).
- **Manual/CSV transactions**: Edit toggles a form (direction toggle Money In/Out, amount, date, merchant); Save calls `updateTransaction` from `mutations.ts`, which overwrites date/amount/merchant/type but passes through the *existing* category/notes unchanged (`scheduleCCategory: tx.schedule_c_category ?? null` — editing the amount does not let you also change category in the same save; that's a separate dropdown).
- Notes field autosaves on blur if changed (`notesMutation`), not on every keystroke.
- The detail-pane category dropdown is the same shared `CategoryDropdown` component as the list view, just absolutely positioned relative to the button instead of viewport-fixed.
- Badges shown: `Settlement` (record_type), `Net Zero Pair` (net_zero_pair_id set), `Sale Linked` (related_sale_id or csv_import).
- **Inventory filter** (added 2026-11-12): "Cost of goods without lots" shows `cost_of_goods` purchases (negative, not net-zero paired, not trade legs) with no `inventory_lot_transactions` link; "partly linked" shows those whose linked `allocated_amount` is less than the charge. Counts appear in the options. Allocations are fetched paged under the `['items', 'lot-allocations']` query key, so any lot link or unlink refreshes it.
- **Unpair** (added 2026-11-12): the `Net Zero Pair` badge has an Unpair action (with a confirm dialog). It calls `unpairNetZero(pairId)` in `mutations.ts`, which clears `net_zero_pair_id` on **every** row carrying that pair id, so it also fixes an orphaned half-pair whose partner was deleted. Both rows then count toward totals again; categories are unchanged.
- **When `schedule_c_category === 'cost_of_goods'`**, renders `TransactionInventorySection` — lets the user link this purchase transaction to one or more `inventory_lots` (see Inventory doc). This is the only place lot↔transaction linking happens outside the Inventory page's "Add Lot" flow.
- Delete (`deleteTransaction`) is a hard delete with a confirm dialog; copy explicitly warns "inventory lots linked to it will be unlinked but kept" (FK `ON DELETE SET NULL`).

## Net-zero matching (added 2026-11-20)

Pairs a charge with the transaction that cancels it exactly (a full refund, or a transfer out and back). Both rows get the same `net_zero_pair_id` and drop out of every Schedule C total (`bucketTransaction`, see data-flows.md). The rules live in `src/lib/netZero.ts` and the UI in `src/components/NetZeroMatch.tsx`.

- **Match rule:** the amounts are exact opposites, compared in whole cents (stored amounts are floats). Partial refunds never match. A refund with a restocking fee withheld is not net zero; see "Partial refunds" below.
- **Eligible rows** (`isPairable`): not already paired, not a trade leg, not linked to a sale or bundle, not a marketplace report row (`source = 'csv_import'`), and not $0.
- **Ranking:** same merchant first, then fewest days apart. "Same merchant" means identical after normalizing, or the same first word of 4 or more letters.
- **Detail panel:** an unpaired, eligible row shows a "Net-zero match" section. It looks up every unpaired row with the exact opposite amount, from any date (up to 200), and shows the best 8, each with a **Pair** button. Exact-opposite rows that are already paired are listed under it, greyed out, with their partner (or "orphaned pair"). That explains a "no match": the refund was already used by another charge. Unpair it to reuse it.
- **"Net-zero pairs" view** (replaced the bulk finder on 2026-11-20): the view switch in the filter row (Transactions | Net-zero pairs) swaps the table for `NetZeroPairsView`. It lists every pair with at least one side in the selected period. The partner is fetched even when it falls outside the period. Each pair shows both rows, which open the detail panel when clicked, how many days apart they are, and an Unpair action with an inline confirm. Orphaned pairs (partner missing), pairs with more than 2 rows, and pairs that don't cancel are listed first and flagged. The search box filters pairs by merchant, account or amount. Pairs are made from a transaction's detail panel, or in bulk with **Find matches in bulk** at the top of the view (`NetZeroFinderModal`, re-added 2026-11-20):
  - it scans unpaired rows in the selected period ±120 days;
  - it builds one-to-one pairs per amount with `proposeNetZeroPairs`: same merchant first, then nearest date, each row used once;
  - it lists every pair with at least one side in the period;
  - same-merchant pairs 90 or fewer days apart are pre-ticked, and pairs between different merchants carry a warning;
  - "Pair selected" pairs the ticked ones through the guarded `pairNetZero` and reports any it couldn't pair.
- **"Net-zero rows" toggle** (filter row, on by default): when turned off, rows with `net_zero_pair_id` are hidden from the transaction list. It counts as an active filter.
- **`pairNetZero(id1, id2)`** (`mutations.ts`) is guarded:
  - it re-reads both rows and refuses unless the cents cancel and neither row is already paired or is a trade leg;
  - it updates with `.is('net_zero_pair_id', null)`;
  - if fewer than 2 rows changed (a race), it clears the new pair id again, so no half-pair is left.
  - `pairTransactions` is now an alias for it.
- **Inventory:** pairing does not touch lots. If the refunded charge funded an inventory lot, unlink or delete that lot as well (Inventory page), or the goods stay on hand at cost.

### Partial refunds / restocking fees

A return refunded minus a restocking fee does not cancel exactly, so it is not a net-zero pair. Book it as follows:

1. The goods never became inventory. Delete the lot, or unlink the original charge from it, so the purchase is not carried at cost.
2. Recategorize the refund (positive) to the **same category as the original charge**. The two then net to the fee inside that category.
3. Step 2 alone gets the Schedule C total right: the fee stays as a net cost in the original category. To show the fee on its own line (Line 27a Other expenses, "restocking fee"), the original charge would have to be split. The app can't split a transaction yet (TASKS.md).

## Review markers (added 2026-11-13)

See `docs/supabase-schema.md` → Review markers.

- **Rows:** a compact badge shows next to the category: amber robot = AI reviewed, green lock = Reviewed by me.
- **Filter:** "Any review / AI reviewed / Reviewed by me / Not reviewed", with counts.
- **Detail panel:** a Review section with "Mark reviewed by me" / "Unlock to edit".
- **Locking:** while a row is owner-reviewed, its category picker is disabled in the panel and inline.
- **Bulk bar:** "Mark reviewed". Bulk "Set category" skips owner-reviewed rows.

## Add Transaction modal

`AddTransactionModal` → `insertTransaction` in `mutations.ts`. Always `source: 'manual'`. No sale-linking, no inventory-linking from this modal — pure standalone transaction entry.

## Receipt attachment

[`ReceiptSection`](../../src/components/ReceiptSection.tsx), rendered in every `TransactionDetail` slide-over (Plaid rows included — receipts are metadata, not one of the fields Plaid rows lock). One file per transaction, image or PDF, 10MB max.

- **Attach**: file picker → `uploadReceipt` uploads to the private `receipts` Storage bucket at `{user_id}/{transaction_id}-{timestamp}.{ext}`, then sets `transactions.receipt_url` to that path.
- **View**: `getReceiptSignedUrl` mints a 5-minute signed URL (bucket is private — no public URLs) and opens it in a new tab.
- **Replace**: uploads the new file first, updates `receipt_url`, then best-effort deletes the old storage object — never leaves the row pointing at nothing if the upload succeeds but cleanup doesn't.
- **Delete**: clears `receipt_url` then removes the storage object.

All four mutations live in `src/lib/mutations.ts`. `receipt_url` stores the storage **path**, not a public URL — same convention `plaid_sync_transactions` already relies on to clean up receipts for Plaid rows removed by a resync.

Not done: no thumbnail/inline preview (view always opens a new tab), no drag-and-drop, no bulk attach. `plaid_exchange_token`'s "Start Fresh" reconnect path doesn't clean up receipt storage blobs when deleting transaction rows (see TASKS.md P1) — this UI doesn't fix that gap, it just makes receipts common enough that it now matters more.

## Gaps vs. mobile (see TASKS.md P1 for the authoritative list)

None outstanding as of 2026-08-27: direction/source/account filters and the period chip picker (`PeriodPicker`, shared across every page) shipped earlier without this item being checked off; Date/Merchant/Amount sort shipped 2026-08-27 (see above). Bulk categorize shipped 2026-07-10; receipt attachment shipped 2026-08-27, see above.

## Plaid metadata in the detail slide-over (added 2026-06-26)

When a transaction has `source = 'plaid'`, the slide-over surfaces:
- Merchant logo (via `MerchantAvatar` — falls back to initial circle if no `merchant_logo_url`).
- Merchant website link (when `merchant_website` is set; opens in a new tab).
- "Pending" amber pill (when `pending = true`).
- Dual dates: "Purchased X · Posted Y" when `authorized_date` differs from `date`.
- Payment channel pill, location row (city · region · store #), non-USD currency callout.
- Detailed PFC + confidence pill next to the existing primary PFC.

All fields render conditionally — manual / CSV / trade-source transactions show none of these.
