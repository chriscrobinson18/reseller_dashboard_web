# Expenses (`src/pages/ExpensesPage.tsx`)

Transaction list + editing surface. The only page where `transactions` rows are directly created/edited/deleted/categorized.

## List view

- Fetches via local `fetchTransactions(start, end)` (same shape as Dashboard's copy, separately defined — see [architecture.md](../architecture.md)).
- Client-side filters (all `useMemo`'d together): text search over `merchant`/`notes` (case-insensitive substring), category dropdown filter (exact match on `schedule_c_category`), and a "Sale rows" toggle (`showSaleLinked`) that by default **hides** rows where `related_sale_id` is set or `source === 'csv_import'` — these are the auto-created payout/fee/shipping rows from `recordSale` (see [data-flows.md](../data-flows.md)).
- Header shows live `income`/`expenses` totals for the *filtered* set (not the exclusion-filtered "business" total Dashboard uses — these are simpler: any positive amount vs. any negative amount in the visible rows) plus an uncategorized-count badge computed from the *unfiltered* period set.
- Inline category change: clicking the `CategoryBadge` in a row opens the shared [`CategoryDropdown`](../../src/components/CategoryDropdown.tsx), a fixed-position popover positioned via CSS vars (`--dd-top`/`--dd-left`) set from the clicked element's bounding rect — not a `<select>`. Mutates via local `updateCategory`, invalidates `['transactions']`.

### Category dropdowns (shared)

Every category picker on this page (top-of-page filter, inline category cell, detail-pane dropdown) renders the shared `CategoryDropdown` component with four sections:

- **Your categories** — user-defined customs (active only, sorted by name)
- **Schedule C** — built-in non-excluded categories
- **Other** — excluded built-ins (Transfer, Personal, Settlement, Balance Adjustment)
- **⚙ Manage categories…** footer — opens `ManageCategoriesModal` for CRUD on custom categories

The same dropdown is also used by [`AddTransactionModal`](../../src/components/modals/AddTransactionModal.tsx). Deleted custom categories don't appear in pickers but historical transactions tagged with them still render as `"Name (deleted)"` and continue to roll up to their resolved `scheduleLine` in the Dashboard Schedule C breakdown — see [`docs/categories.md`](../categories.md#custom-categories-shipped-2026-06-25).

## Detail panel (`TransactionDetail`, inside a `SlideOver`)

- **Plaid-sourced transactions** (`source === 'plaid'`) are read-only except category and notes — no Edit button, edit-mode amount/date/merchant fields don't render. Delete still works (removes the row).
- **Manual/CSV transactions**: Edit toggles a form (direction toggle Money In/Out, amount, date, merchant); Save calls `updateTransaction` from `mutations.ts`, which overwrites date/amount/merchant/type but passes through the *existing* category/notes unchanged (`scheduleCCategory: tx.schedule_c_category ?? null` — editing the amount does not let you also change category in the same save; that's a separate dropdown).
- Notes field autosaves on blur if changed (`notesMutation`), not on every keystroke.
- The detail-pane category dropdown is the same shared `CategoryDropdown` component as the list view, just absolutely positioned relative to the button instead of viewport-fixed.
- Badges shown: `Settlement` (record_type), `Net Zero Pair` (net_zero_pair_id set), `Sale Linked` (related_sale_id or csv_import).
- **When `schedule_c_category === 'cost_of_goods'`**, renders `TransactionInventorySection` — lets the user link this purchase transaction to one or more `inventory_lots` (see Inventory doc). This is the only place lot↔transaction linking happens outside the Inventory page's "Add Lot" flow.
- Delete (`deleteTransaction`) is a hard delete with a confirm dialog; copy explicitly warns "inventory lots linked to it will be unlinked but kept" (FK `ON DELETE SET NULL`).

## Add Transaction modal

`AddTransactionModal` → `insertTransaction` in `mutations.ts`. Always `source: 'manual'`. No sale-linking, no inventory-linking from this modal — pure standalone transaction entry.

## Gaps vs. mobile (see TASKS.md P1 for the authoritative list)

No bulk categorize (multi-select), no sort (date/amount/merchant asc/desc), no account filter beyond the period preset, no receipt attachment UI despite `receipt_url` existing on the type.
