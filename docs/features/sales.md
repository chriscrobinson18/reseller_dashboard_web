# Sales (`src/pages/SalesPage.tsx`)

The relational centerpiece of the app — every sale here can cascade into `transactions` rows and `inventory_lots` depletion. See [data-flows.md](../data-flows.md) for the full recordSale/updateSale/deleteSale mechanics; this doc covers the page/UI layer.

## List view

- `fetchSales(start, end)` joins `items(id,name,category)` and `inventory_movements(id,quantity,inventory_lots(unit_cost,item_id))`, excludes soft-deleted, `.limit(2000)`.
- Search filters client-side over item name, `external_order_id`, and `platform`.
- Header shows total revenue (net of partial-return refunds, full returns excluded — same formula as Dashboard) and a "needs inventory link" count (`!s.item_id`).
- Unlinked sales (`item_id` null — typically arrive via CSV import) show an inline "Link to inventory item" action directly in the table row instead of the item name.
- Status badges per row: `inventory_status` (`ok`/`oversold`/`reconciled`) and `return_status` (`none` renders nothing, `partial`/`full`).

## Detail panel (`SaleDetail`, inside a `SlideOver`)

- Computes COGS from `inventory_movements` (FIFO), `netRevenue` (return-adjusted), `profit = netRevenue - cogs - fees - shipping` — all locally, not imported from a shared helper (see [data-flows.md](../data-flows.md) "FIFO COGS computation" for why this is duplicated three places).
- "Link to inventory item" CTA shown when `!sale.item_id`.
- Inventory Used (FIFO) table: one row per `inventory_movements` entry (qty, unit cost, line COGS). If empty and `inventory_status === 'oversold'`, shows "Sale was oversold."
- Return info box shown whenever `return_status !== 'none'` (qty + amount refunded). No UI to *initiate* a return yet — `record_return` edge function exists server-side but nothing in this repo calls it (P1 gap, see TASKS.md).
- Profitability breakdown only renders when there's at least one inventory movement (`hasCogsData`) — an unlinked or zero-COGS sale shows the metrics grid but not the profit card.

## Modals

- **RecordSaleModal** → `recordSale` (item + qty + price + platform + date + optional fees/shipping/order ID). See [data-flows.md](../data-flows.md) for what this fans out into.
- **EditSaleModal** → `updateSale`. For manual sales, keeps linked transaction rows in sync; for non-manual (CSV/Plaid-originated) sales, only the `sales` row changes.
- **LinkSaleToItemModal** → `linkSaleToItem`, a one-column `.update({ item_id })`. Does not retroactively create `inventory_movements` for past depletion — linking after the fact does not fix `inventory_status`.
- **Delete** → `deleteSale`, confirm dialog warns "Inventory already depleted is not restored" (this is the known bug — see [data-flows.md](../data-flows.md)).

## Gaps vs. mobile (TASKS.md P1)

No "Process Return" UI (return entry doesn't exist on either client yet — would be a web-first feature). No per-platform breakdown/filter in the table.
