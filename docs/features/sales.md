# Sales (`src/pages/SalesPage.tsx`)

The relational centerpiece of the app — every sale here can cascade into `transactions` rows and `inventory_lots` depletion. See [data-flows.md](../data-flows.md) for the full recordSale/updateSale/deleteSale mechanics; this doc covers the page/UI layer.

## List view

- `fetchSales(start, end)` joins `items(id,name,category)` and `inventory_movements(id,quantity,inventory_lots(unit_cost,item_id))`, excludes soft-deleted, `.limit(2000)`.
- Search filters client-side over item name, `external_order_id`, and `platform`.
- Header shows total revenue (net of partial-return refunds, full returns excluded — same formula as Dashboard) and a "needs inventory link" count (`!s.item_id`).
- Unlinked sales (`item_id` null — typically arrive via CSV import) show an inline "Link to inventory item" action directly in the table row instead of the item name.
- Status badges per row: `inventory_status` (`ok`/`oversold`/`reconciled`) and `return_status` (`none` renders nothing, `partial`/`full`).

## Detail panel (`SaleDetail`, inside a `SlideOver`)

- Profit math goes through the shared `saleProfit(sale)` helper in [`src/lib/saleProfit.ts`](../../src/lib/saleProfit.ts) (extracted 2026-06-23): COGS from `inventory_movements` (FIFO), `netRevenue` (return-adjusted), `profit = netRevenue - cogs - fees - shipping`. Unit-tested in `src/lib/__tests__/saleProfit.test.ts` (no return / partial / full / oversold / missing fees).
- "Link to inventory item" CTA shown when `!sale.item_id`.
- Inventory Used (FIFO) table: one row per `inventory_movements` entry (qty, unit cost, line COGS). If empty and `inventory_status === 'oversold'`, shows "Sale was oversold."
- Return info box shown whenever `return_status !== 'none'` (qty + amount refunded). No UI to *initiate* a return yet — `record_return` (deployed as v21 on 2026-06-23, with cost-basis + refund-transaction-row fixes) is correct server-side but nothing in this repo calls it (P1 gap, see TASKS.md).
- Profitability breakdown only renders when there's at least one inventory movement (`hasCogsData`) — an unlinked or zero-COGS sale shows the metrics grid but not the profit card.

## Modals

- **RecordSaleModal** → `recordSale` (item + qty + price + platform + date + optional fees/shipping/order ID). See [data-flows.md](../data-flows.md) for what this fans out into.
- **EditSaleModal** → `updateSale`. For manual sales, keeps linked transaction rows in sync; for non-manual (CSV/Plaid-originated) sales, only the `sales` row changes.
- **LinkSaleToItemModal** → `linkSaleToItem`, a one-column `.update({ item_id })`. Does not retroactively create `inventory_movements` for past depletion — linking after the fact does not fix `inventory_status`.
- **Delete** → `deleteSale`, which invokes the `reverse_sale` edge function. This atomically restores `quantity_remaining` on every depleted lot, deletes the `inventory_movements` audit rows, deletes the linked manual `transactions` rows, and soft-deletes the sale — all in one Postgres transaction with FOR UPDATE locks on the affected lot rows. See [data-flows.md](../data-flows.md) for the full breakdown.

## Trade-linked sales

Sales created as the given side of a barter trade (`source = 'trade'`, `trade_id` set) display a purple **"Trade"** pill in the platform/source column instead of the usual platform badge. Clicking the pill opens `TradeDetailSlideOver` (`src/components/TradeDetailSlideOver.tsx`) for the parent trade.

**Do not edit trade-linked sales directly** — the sale's `sale_price` is the given-side FMV, and its linked income/COGS transactions are the trade's bundled non-cash legs, not per-sale transactions. Use the trade as the canonical handle: delete the trade via `TradeDetailSlideOver` to reverse all legs atomically. The current `deleteSale` still works on a trade-linked sale via `reverse_sale` (it will restore the depleted lots and soft-delete the sale), but it leaves the paired non-cash transactions and the `trades` row orphaned. The `EditSaleModal` is disabled for `source = 'trade'` sales.

## Gaps vs. mobile (TASKS.md P1)

No "Process Return" UI (return entry doesn't exist on either client yet — would be a web-first feature). No per-platform breakdown/filter in the table.
