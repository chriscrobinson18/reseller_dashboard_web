# Sales (`src/pages/SalesPage.tsx`)

The relational centerpiece of the app — every sale here can cascade into `transactions` rows and `inventory_lots` depletion. See [data-flows.md](../data-flows.md) for the full recordSale/updateSale/deleteSale mechanics; this doc covers the page/UI layer.

## List view

- `fetchSales(start, end)` joins `items(id,name,category)` and `inventory_movements(id,quantity,inventory_lots(unit_cost,item_id))`, excludes soft-deleted, `.limit(2000)`. It also issues a second query for every `transactions` row with `related_sale_id` in the visible sale IDs and sums by sale, returning `{ sales, netPayoutBySale }`.
- Search filters client-side over item name, `external_order_id`, and `platform`.
- Header shows total revenue (net of partial-return refunds, full returns excluded — same formula as Dashboard) and a "needs inventory link" count (`needsInventoryLink`).
- **`needsInventoryLink(sale)`** (2026-11-23): true when the sale has no `inventory_movements` and isn't fully returned. It used to be `!sale.item_id`, which hid the link action on sales linked before 2026-11-12 (when linking only set `item_id` and took no lot units). Fully returned sales are excluded because the return already reversed their movements; linking one would take units that came back.
- Sales with no item show an inline "Link to inventory item" action in place of the item name. Sales with an item but no lot units show the item name plus "Link to inventory lots". Both open `LinkSaleToItemModal`, which preselects the sale's current item.
- Status badges per row: `inventory_status` (`ok`/`oversold`/`reconciled`) and `return_status` (`none` renders nothing, `partial`/`full`).
- **Net Payout column** (`netPayoutFor(sale, netPayoutBySale)`) — the sum of every `transactions` row linked to the sale via `related_sale_id` (payout, fees, shipping, refund, return-shipping), which is the true cash impact including any return. Falls back to `sale.net_payout ?? sale_price - fees` when a sale has no linked transactions (e.g. CSV-imported sales). Renders in red when negative — common once a return's refund + return-shipping cost exceed the original payout.

## Detail panel (`SaleDetail`, inside a `SlideOver`)

- Profit math goes through the shared `saleProfit(sale)` helper in [`src/lib/saleProfit.ts`](../../src/lib/saleProfit.ts) (extracted 2026-06-23): COGS from `inventory_movements` (FIFO), `netRevenue` (return-adjusted), `profit = netRevenue - cogs - fees - shipping`. Unit-tested in `src/lib/__tests__/saleProfit.test.ts` (no return / partial / full / oversold / missing fees).
- "Link to inventory item" / "Link to inventory lots" CTA shown when `needsInventoryLink(sale)`.
- Inventory Used (FIFO) table: one row per `inventory_movements` entry (qty, unit cost, line COGS). If empty and `inventory_status === 'oversold'`, shows "Sale was oversold."
- Return info box shown whenever `return_status !== 'none'` (qty + amount refunded).
- "Process Return" / "Edit Return" action button shown whenever the sale isn't trade-linked (label switches to "Edit Return" once `return_status !== 'none'`); opens `ProcessReturnModal`.
- Metrics grid's "Net Payout" field uses the same linked-transactions sum as the table column (see List view above), shown in red when negative.
- Profitability breakdown only renders when there's at least one inventory movement (`hasCogsData`) — an unlinked or zero-COGS sale shows the metrics grid but not the profit card.
- **Return info (2026-11-23):** shown only for `full`/`partial`. Sales without a return are stored as `'none'`, never null, so the list's return filter now treats both as "no return"; before, "No returns" showed nothing and "Has a return" showed everything. Platform imports record a refund without a quantity, so the panel shows "all, from platform report" instead of "Qty: 0", and warns when the refund exceeds the sale price.
- **Paid directly (2026-11-23):** charges attributed to the sale from Expenses (`transactions.profit_sale_id`, e.g. a label paid with your own card) are loaded by `fetchDirectCosts` into `sale.direct_costs`, subtracted in `saleProfit`, and shown as a "Paid directly (bank/card)" line. Net payout is unchanged, because it's what the platform paid you; Schedule C is unchanged too.

## Review markers (added 2026-11-13)

The detail panel opens with a Review section ("Mark reviewed by me" / "Unlock to edit"); list rows show a compact badge. An owner-reviewed sale's item link, money fields and date are locked against AI and imports. Its sale↔lot movements are locked against AI. See `docs/supabase-schema.md` → Review markers.

## Returns & refunds workflow (2026-11-23)

**In the app, the sale panel's "Inventory" box does this for you** (`SaleInventoryBox`, rules in `src/lib/saleInventory.ts`). It shows what the sale did to inventory and offers the one action that fits:

| Box state | Shown | Action |
|---|---|---|
| Linked | "N units taken from inventory" (plus "oversold" if short) | — |
| Needs a link | Amber; up to 3 **suggested items** | **Link** on a suggestion, or "Choose an item…" |
| Full refund, no units out | "Nothing left inventory: right if it came back or never shipped" | "Buyer kept it or it was lost?…": take the units from the sale's item, a suggestion, or a chosen item (`resolve_sale_refund('kept')`) |
| Full refund, units out | "N units counted as gone: right if the buyer kept it or it was lost" | "It came back / never shipped: put it back" (`resolve_sale_refund('back')`, whatever the sale's history) |
| Partial refund | Refund, units out, units returned | "Some units came back? Record them…" / "No units came back? Link to inventory…" |

- **One operation, `resolve_sale_refund(sale, 'back' | 'kept', item?)`** (migration `20261123140000`, `resolveSaleRefund` in `mutations.ts`), for fully refunded sales only. It is atomic and idempotent, and never changes the refund amount (Line 2).
  - **'back':** every unit the sale holds returns to its own lot (refused if a lot would exceed its purchased quantity), the `returns` rows are topped up to cover the full quantity without adding to the refund, `refunded_quantity` becomes the quantity, and the status becomes `reconciled` (clears `oversold`).
  - **'kept':** in-app return rows with no linked transaction are removed, the missing units are taken oldest-first (as `link_sale_to_item` does), `refunded_quantity` becomes 0, and the status becomes `ok` or `oversold`.

  It replaces choosing between Put back, Edit Return and Link by history. That choice once left a unit stuck when a sale was linked after its return.
- **Bulk on the Sales list:** fully refunded rows have a checkbox (shift-click selects a range; the header box selects all shown). The action bar offers **Came back / never shipped** and **Buyer kept it / lost**, and the footer reports how many sales and units changed and lists any failures (e.g. "Choose the inventory item first"). The Returns filter has **"Refunded, units still out"**, and those rows carry an amber **"N out"** badge.
- **No stored answer:** the state is inferred from the sale (units taken or not), so both outcomes of a refund are valid end states and the box offers the switch.
- **Suggestions** (`suggestItems`): words are weighted by rarity across your items (IDF), so brand words like "pokemon" or "lego" don't decide. A match needs at least 80% of the item name's weight and at least one distinctive word (in 3 or fewer items, or a 3+ digit model number). **Single cards** (a collector number, a condition such as "Near Mint", or a frame variant such as "(Borderless)") get no sealed-product suggestion; the box points to Breakdowns instead. With no match it says the purchase may have no lot yet.
- The return button reads **"Record return details"** when the refund came from a platform import (no in-app return yet).
- Sale profitability now subtracts the refund for **full** returns too (`saleProfit`), so a refunded sale shows its real result.

Taxes: Line 1 counts every sale and Line 2 counts `refunded_amount`, so a full refund nets income to $0 whether or not inventory is linked. Inventory linking decides only whether the unit's cost becomes cost of goods sold.

| Scenario | Imported sale (eBay / TCGplayer / Amazon) | Manual sale |
|---|---|---|
| **Normal sale** | Import, then **Link to inventory** | Record Sale (pick the item, so units are taken), or link afterwards |
| **Shipped, then returned** (item back) | The refund arrives with the import as a full return. **Don't link.** If it was linked, use **Edit Return** with the same refund to restore the units | Process Return (quantity + refund): the units go back to their lot at the original cost |
| **Refunded before shipping** (cancelled) | Arrives as a full return. **Don't link** | Process Return (full). If no money ever moved, deleting the sale is fine |
| **Refunded, buyer kept it / lost** | Use the sale panel's "Buyer kept it / lost in transit? Link to inventory" | Keep the link. **Gap:** a refund with no units back can't be recorded yet (`record_return` requires quantity ≥ 1), so Line 2 misses it (TASKS.md) |
| **Partial return** | Link, then Process Return for the units that came back (the refund reconciles with the imported one) | Link, then Process Return for those units |

- **Return label you paid with your card:** leave the **Return Shipping Cost** field blank. The bank charge stays a Shipping & Postage expense (Line 27a); use Expenses → **Sale profit** to attribute it to the sale. A figure typed into that field doesn't reach Schedule C yet (TASKS.md).
- **Returned item is damaged or unsellable:** there's no write-off action yet. Delete that unit's lot, or reduce it, so it isn't carried as inventory.

## Modals

- **RecordSaleModal** → `recordSale` (item + qty + price + platform + date + optional fees/shipping/order ID). See [data-flows.md](../data-flows.md) for what this fans out into.
- **Link to inventory** (`LinkSaleToItemModal` → `linkSaleToItem`): since 2026-11-12 this calls the `link_sale_to_item` RPC, which assigns the item **and** FIFO-depletes its lots (preferring lots bought on/before the sale date) with `inventory_movements`, marking the sale oversold if units run short. Before, it only set `item_id`.
- **Platform list** is shared by Record Sale, Edit Sale and Edit Bundle: `SALE_PLATFORMS` in [`src/lib/salePlatforms.ts`](../../src/lib/salePlatforms.ts). `goldin` (auction-house consignment sales) was added 2026-11-10. The Year-End Tie-Out pairs sales with settlement deposits by platform, so a venue that pays by bank deposit needs an entry matching the deposit's `transactions.platform` label.
- **EditSaleModal** → `updateSale`. For manual sales, keeps linked transaction rows in sync; for non-manual (CSV/Plaid-originated) sales, only the `sales` row changes.
- **Delete** → `deleteSale`, which invokes the `reverse_sale` edge function. This atomically restores `quantity_remaining` on every depleted lot, deletes the `inventory_movements` audit rows, deletes the linked manual `transactions` rows, and soft-deletes the sale — all in one Postgres transaction with FOR UPDATE locks on the affected lot rows. See [data-flows.md](../data-flows.md) for the full breakdown.
- **ProcessReturnModal** → `recordReturn` (`src/lib/mutations.ts`), which invokes the `record_return` edge function (return-shipping cost deployed 2026-08-25; CSV-reconciliation v2 deployed 2026-09-23) with `sale_id`, `quantity`, `refund_amount`, optional `return_shipping_cost`, optional `reason`. Server-side this reverses the sale's `inventory_movements` LIFO (restoring `quantity_remaining` at each lot's original `unit_cost`, not sale price), updates `refunded_quantity`/`refunded_amount`/`return_status` (`partial` vs `full`) and `inventory_status` (`reconciled`) on the sale, and inserts a `returns_allowances`-categorized refund `transactions` row (negative amount, `related_sale_id` set) so it nets correctly against Part I gross receipts. If `return_shipping_cost > 0` — the label cost of shipping the item back, paid by the seller — it also inserts a second `transactions` row categorized `shipping_postage` (a deductible expense, distinct from the buyer refund). Both refund-related rows share `type: 'refund'` so `reverse_return` can find and delete exactly them. Quantity is capped client-side to `sale.quantity - sale.refunded_quantity` when processing a new return, or to the full `sale.quantity` when editing an existing one (see below).
- **Edit Return** — this app supports at most one active return per sale. Editing is implemented as delete-then-re-record (same workaround pattern as this codebase's trade editing): `ProcessReturnModal` pre-fills from `fetchActiveReturn(saleId)` (reads the `returns` table row plus its linked return-shipping transaction), and on submit calls `reverseReturn(returnId)` — which invokes the `reverse_return` edge function ([source](../../supabase/functions/reverse_return/index.ts)) to re-deplete inventory FIFO, decrement the sale's refund totals, and delete the linked refund/return-shipping transactions and the `returns` row — followed by a fresh `recordReturn` call with the edited values.

## Payment method

`sales.payment_method` records **how** the money arrived, separately from `platform`, which records **where** the sale happened. The two are orthogonal — the same rail (PayPal) settles sales from different marketplaces, and an in-person sale has no marketplace at all. Folding rails into `platform` would have broken per-marketplace reporting.

The known list lives in [`src/lib/paymentMethods.ts`](../../src/lib/paymentMethods.ts): Cash, Venmo, Cash App, PayPal, Apple Pay, Zelle, Card, Other. The column is unconstrained, so adding a rail is a one-line change with no migration.

Each entry carries a `reports1099k` flag. Venmo, Cash App, PayPal and Card issue a 1099-K for goods-and-services volume; **cash, Zelle and Apple Pay don't** (Zelle is exempt as a bank-to-bank network). The flag exists so a future reconciliation view can explain why recorded sales exceed 1099-K totals instead of treating the gap as an error. `isUnreportedRail()` is the helper — nothing consumes it yet.

Selectable in both `RecordSaleModal` and `EditSaleModal` (optional; the hint changes to "How you were paid" when platform is `manual`), shown as a pill on the list and detail panel, and searchable by both stored value and display label.

`record_sale` doesn't accept the field, so `recordSale()` writes it back onto the row right after creation — the same pattern already used for fees/shipping.

**Split payments (2026-11-13).** The dropdown's last option, **Split across methods…**, opens an editor of method + amount rows (min two) with a live "unassigned / over / covers $X" readout; focusing an empty amount fills in the remainder. Submit is blocked until the amounts add up to the sale price (bundle total in bundle mode). Available in Record Sale (single and bundle), Edit Sale (not for bundle lines — their payment is order-level) and Edit Bundle. Stored as `payment_method = 'split'` + `payments` jsonb; the list pill reads **Split** (hover for the breakdown), the detail panel and bundle panel show `Split: Cash $60.00 + Venmo $40.00`, and search matches the methods inside a split. Picking a single method again clears the breakdown. One payout transaction is still created for the full amount — see [data-flows.md](../data-flows.md#split-payments-payments-jsonb).

## Bundle sales (multi-item orders)

There's one entry point, `RecordSaleModal` — no separate "bundle" button. It opens in ordinary single-item mode; clicking **Add another item** (labeled "makes this a bundle sale" the first time) appends a second item row and the form relabels itself in place: heading becomes "Items (N)" with a running total, "Platform Fees" becomes "Order Fees", hints switch to "applies once, to the whole order", and the submit button switches from **Record Sale** to **Record Bundle Sale**. Removing rows back down to one reverts every label. `isBundle = lines.length > 1` is the only branch — same component, same state, two submit paths (`recordSale` vs `recordBundleSale` in `mutations.ts`).

This shape was chosen over a separate modal deliberately: a bundle is discovered mid-entry ("oh, this order actually had two items"), not decided up front, so the natural action is adding a row to the sale you're already filling out rather than abandoning it for a different form.

Order-level fields (date, platform, payment method, order ID, **fees**, **shipping**) sit above the item list and apply once regardless of line count. In bundle mode a **Notes** field also appears (bundle-only — a single sale has nowhere to show notes today). Per-line oversell warnings appear inline — computed against the **total units requested for that item across all lines**, so the same item on two lines (2 + 2 with 3 in stock) still warns — and oversold lines are non-fatal in both modes (`recordSale`'s existing behavior; `recordBundleSale` mirrors it).

**Model.** Each line becomes an ordinary `sales` row via the untouched `record_sale` edge function, sharing a `bundle_id`. FIFO depletion, `inventory_movements`, returns and `reverse_sale` all work unchanged, and per-item profit works unmodified because each line carries its own price — `saleProfit.ts` needed no changes. See [supabase-schema.md](../supabase-schema.md#sale_bundles) for why this follows the `trades` precedent instead of restructuring `sales` into line items.

**Fees and shipping apply once, to the whole order.** They're written as a single payout/fee/shipping transaction set tagged `related_bundle_id`, never per line, and each line row is stored with `fees=0`/`shipping_cost=null`.

For *display and profit*, though, that order-level charge is allocated back across the lines **proportionally by line price** (a $100 line in a $200 order bears half the fee), into the client-only `allocated_fees`/`allocated_shipping` fields — see [data-flows.md](../data-flows.md#recording-a-bundle-sale-recordbundlesale-in-mutationsts). `saleProfit()` prefers those over the row's zeroed columns; without it every bundle line reports profit as though the order were free to sell. The Sales list's **Net** column uses the same allocation, since a bundle's transactions carry `related_bundle_id` and so are invisible to the `related_sale_id` net-payout lookup.

**All-or-nothing recording (2026-11-13).** If any line or the transaction insert fails, everything already written (earlier lines' inventory draw-down, the bundle row) is undone and the modal shows "Sale not recorded … Nothing was saved", so retrying can't double-count. See [data-flows.md](../data-flows.md#recording-a-bundle-sale-recordbundlesale-in-mutationsts).

**Bundles page Net Payout fix (2026-11-13).** `useBundles` was multiplying `sale_price × quantity`, but `sale_price` is already the line total — any line with quantity > 1 inflated the page's Net Payout. Display only; transactions and Schedule C were never affected.

**Display** (chosen over grouping rows): each line stays its own row so the list's existing sorting, filtering and search keep working untouched; bundle membership shows as a clickable blue **Bundle** pill next to the platform badge. The pill and a banner in the sale detail both open `BundleDetailSlideOver` — lines with per-item prices, Schedule C impact (payout/fees/shipping), **Edit**, and **Delete bundle**, which reverses every line's FIFO depletion via `reverse_sale`, removes the bundle transactions, and soft-deletes the bundle. Unlike a trade, an individual bundle line stays returnable on its own, since it isn't a barter leg with an FMV constraint.

**Editing a bundle.** `BundleDetailSlideOver`'s **Edit** opens `EditBundleModal`, seeded from `useBundle`: the order-level fields (date, platform, payment method, order ID, fees, shipping, notes) plus every line's own quantity and price. `updateBundleSale` (`mutations.ts`) writes the `sale_bundles` row, re-stamps date/platform/payment method/order ID onto every line (they're each line's own copy, set at creation — see below), and syncs the bundle's payout/fee/shipping transactions by `schedule_c_category`: fee/shipping rows are created if a positive value is newly added (the bundle may have been recorded with no fee at all), updated if one already exists, and deleted if edited down to zero. Without the create step, the Schedule C card below would show nothing for a fee added after the fact even though the bundle total and every line's allocated share already reflect it.

**Line item is not editable, on purpose.** Swapping a line's item would mean reversing that line's FIFO depletion and re-depleting a different item's lots — a different shape of change than a plain field edit, closer to delete-line-then-add-line. Quantity and price are.

**A bundle line's own `EditSaleModal` now only offers Quantity and Sale Price.** Before this, the per-line Edit button let you type into Platform/Payment Method/Sale Date/Order ID/Fees/Shipping — order-level facts, not per-line ones — which could desync a line from its siblings and, for Fees/Shipping, write a nonzero value into a column the whole allocation model (`allocated_fees`/`allocated_shipping`, above) assumes is always `0`/`null` on a bundle line. Those fields are now edited only from the bundle.

## Trade-linked sales

Sales created as the given side of a barter trade (`source = 'trade'`, `trade_id` set) display a purple **"Trade"** pill in the platform/source column instead of the usual platform badge. Clicking the pill opens `TradeDetailSlideOver` (`src/components/TradeDetailSlideOver.tsx`) for the parent trade.

**Do not edit trade-linked sales directly** — the sale's `sale_price` is the given-side FMV, and its linked income/COGS transactions are the trade's bundled non-cash legs, not per-sale transactions. Use the trade as the canonical handle: delete the trade via `TradeDetailSlideOver` to reverse all legs atomically. The current `deleteSale` still works on a trade-linked sale via `reverse_sale` (it will restore the depleted lots and soft-delete the sale), but it leaves the paired non-cash transactions and the `trades` row orphaned. The `EditSaleModal` is disabled for `source = 'trade'` sales.

## Apple Shortcuts quick entry

Users record unlinked manual sales and inventory breakdowns from iPhone without opening the web app.

**Setup:** Settings → Apple Shortcuts → Generate Token → Copy → Add to Shortcuts → paste token on first run.

**Fields captured (sale):** item name (free text), quantity, sale price, payment method. Date defaults to today UTC. No FIFO depletion — sale is created with `item_id = null` and `source = 'manual'`. The `item_name` column stores the original description even after the sale is linked to inventory.

**Fields captured (breakdown):** item name (free text), quantity. Date defaults to today UTC. Creates an incomplete `box_openings` row with `source_lot_id = null` and `box_cost = null`. Complete it via "Breakdown Inventory" in the web app.

**Attention banners:**
- Sales page: ⚠️ banner for shortcut sales where `item_id IS NULL AND item_name IS NOT NULL`
- Inventory page: ⚠️ banner for incomplete breakdowns where `box_openings.source_lot_id IS NULL`

**Auth:** `profiles.shortcut_token` UUID. Edge functions `shortcut_record_sale` and `shortcut_record_breakdown` use service role — no JWT required in the Shortcut.

**Regenerating** the token in Settings immediately invalidates the old one. The Shortcut will prompt for a new token on the next run.

## Gaps vs. mobile (TASKS.md P1)

No per-platform breakdown/filter in the table.
