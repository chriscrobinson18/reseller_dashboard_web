# Sales (`src/pages/SalesPage.tsx`)

The relational centerpiece of the app — every sale here can cascade into `transactions` rows and `inventory_lots` depletion. See [data-flows.md](../data-flows.md) for the full recordSale/updateSale/deleteSale mechanics; this doc covers the page/UI layer.

## List view

- `fetchSales(start, end)` joins `items(id,name,category)` and `inventory_movements(id,quantity,inventory_lots(unit_cost,item_id))`, excludes soft-deleted, `.limit(2000)`. It also issues a second query for every `transactions` row with `related_sale_id` in the visible sale IDs and sums by sale, returning `{ sales, netPayoutBySale }`.
- Search filters client-side over item name, `external_order_id`, and `platform`.
- Header shows total revenue (net of partial-return refunds, full returns excluded — same formula as Dashboard) and a "needs inventory link" count (`!s.item_id`).
- Unlinked sales (`item_id` null — typically arrive via CSV import) show an inline "Link to inventory item" action directly in the table row instead of the item name.
- Status badges per row: `inventory_status` (`ok`/`oversold`/`reconciled`) and `return_status` (`none` renders nothing, `partial`/`full`).
- **Net Payout column** (`netPayoutFor(sale, netPayoutBySale)`) — the sum of every `transactions` row linked to the sale via `related_sale_id` (payout, fees, shipping, refund, return-shipping), which is the true cash impact including any return. Falls back to `sale.net_payout ?? sale_price - fees` when a sale has no linked transactions (e.g. CSV-imported sales). Renders in red when negative — common once a return's refund + return-shipping cost exceed the original payout.

## Detail panel (`SaleDetail`, inside a `SlideOver`)

- Profit math goes through the shared `saleProfit(sale)` helper in [`src/lib/saleProfit.ts`](../../src/lib/saleProfit.ts) (extracted 2026-06-23): COGS from `inventory_movements` (FIFO), `netRevenue` (return-adjusted), `profit = netRevenue - cogs - fees - shipping`. Unit-tested in `src/lib/__tests__/saleProfit.test.ts` (no return / partial / full / oversold / missing fees).
- "Link to inventory item" CTA shown when `!sale.item_id`.
- Inventory Used (FIFO) table: one row per `inventory_movements` entry (qty, unit cost, line COGS). If empty and `inventory_status === 'oversold'`, shows "Sale was oversold."
- Return info box shown whenever `return_status !== 'none'` (qty + amount refunded).
- "Process Return" / "Edit Return" action button shown whenever the sale isn't trade-linked (label switches to "Edit Return" once `return_status !== 'none'`); opens `ProcessReturnModal`.
- Metrics grid's "Net Payout" field uses the same linked-transactions sum as the table column (see List view above), shown in red when negative.
- Profitability breakdown only renders when there's at least one inventory movement (`hasCogsData`) — an unlinked or zero-COGS sale shows the metrics grid but not the profit card.

## Modals

- **RecordSaleModal** → `recordSale` (item + qty + price + platform + date + optional fees/shipping/order ID). See [data-flows.md](../data-flows.md) for what this fans out into.
- **EditSaleModal** → `updateSale`. For manual sales, keeps linked transaction rows in sync; for non-manual (CSV/Plaid-originated) sales, only the `sales` row changes.
- **LinkSaleToItemModal** → `linkSaleToItem`, a one-column `.update({ item_id })`. Does not retroactively create `inventory_movements` for past depletion — linking after the fact does not fix `inventory_status`.
- **Delete** → `deleteSale`, which invokes the `reverse_sale` edge function. This atomically restores `quantity_remaining` on every depleted lot, deletes the `inventory_movements` audit rows, deletes the linked manual `transactions` rows, and soft-deletes the sale — all in one Postgres transaction with FOR UPDATE locks on the affected lot rows. See [data-flows.md](../data-flows.md) for the full breakdown.
- **ProcessReturnModal** → `recordReturn` (`src/lib/mutations.ts`), which invokes the `record_return` edge function (deployed as v21 on 2026-06-23; **local source not yet redeployed for the `return_shipping_cost` param below — see Deployment note**) with `sale_id`, `quantity`, `refund_amount`, optional `return_shipping_cost`, optional `reason`. Server-side this reverses the sale's `inventory_movements` LIFO (restoring `quantity_remaining` at each lot's original `unit_cost`, not sale price), updates `refunded_quantity`/`refunded_amount`/`return_status` (`partial` vs `full`) and `inventory_status` (`reconciled`) on the sale, and inserts a `returns_allowances`-categorized refund `transactions` row (negative amount, `related_sale_id` set) so it nets correctly against Part I gross receipts. If `return_shipping_cost > 0` — the label cost of shipping the item back, paid by the seller — it also inserts a second `transactions` row categorized `shipping_postage` (a deductible expense, distinct from the buyer refund). Both refund-related rows share `type: 'refund'` so `reverse_return` can find and delete exactly them. Quantity is capped client-side to `sale.quantity - sale.refunded_quantity` when processing a new return, or to the full `sale.quantity` when editing an existing one (see below).
- **Edit Return** — this app supports at most one active return per sale. Editing is implemented as delete-then-re-record (same workaround pattern as this codebase's trade editing): `ProcessReturnModal` pre-fills from `fetchActiveReturn(saleId)` (reads the `returns` table row plus its linked return-shipping transaction), and on submit calls `reverseReturn(returnId)` — which invokes the `reverse_return` edge function ([source](../../supabase/functions/reverse_return/index.ts)) to re-deplete inventory FIFO, decrement the sale's refund totals, and delete the linked refund/return-shipping transactions and the `returns` row — followed by a fresh `recordReturn` call with the edited values.

## Trade-linked sales

Sales created as the given side of a barter trade (`source = 'trade'`, `trade_id` set) display a purple **"Trade"** pill in the platform/source column instead of the usual platform badge. Clicking the pill opens `TradeDetailSlideOver` (`src/components/TradeDetailSlideOver.tsx`) for the parent trade.

**Do not edit trade-linked sales directly** — the sale's `sale_price` is the given-side FMV, and its linked income/COGS transactions are the trade's bundled non-cash legs, not per-sale transactions. Use the trade as the canonical handle: delete the trade via `TradeDetailSlideOver` to reverse all legs atomically. The current `deleteSale` still works on a trade-linked sale via `reverse_sale` (it will restore the depleted lots and soft-delete the sale), but it leaves the paired non-cash transactions and the `trades` row orphaned. The `EditSaleModal` is disabled for `source = 'trade'` sales.

## Gaps vs. mobile (TASKS.md P1)

No per-platform breakdown/filter in the table.
