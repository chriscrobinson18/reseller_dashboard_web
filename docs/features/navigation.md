# Cross-page navigation (linked records + deep links)

Added 2026-11-20. From any record you can jump straight to the records it is connected to on other pages.

## Deep links (`src/lib/nav.ts`)

Each page opens the record named in its query parameter:

| Page | URL | Opens |
|---|---|---|
| Expenses | `/expenses?tx=<id>` | transaction detail panel |
| Sales | `/sales?sale=<id>` | sale detail panel |
| Inventory | `/inventory?lot=<id>` | the lot's panel (funding + linked records) |
| Bundles | `/bundles?bundle=<id>` | bundle detail |
| Trades | `/trades?trade=<id>` | trade detail |
| Breakdowns | `/breakdowns?breakdown=<id>` | breakdown detail |

- The record opens even when it is outside the page's selected period. Expenses and Sales fetch it by id; a bundle line is fetched with its whole bundle, so the fee allocation matches the list.
- `useDeepLink(kind)` returns the id and a clear function. The deep-linked id wins over a row click until the panel is closed. Closing removes the parameter, using `replace` so no history entry is added.
- Inventory only finds lots that are not deleted. A deleted lot has nothing to open.

## Linked records panel (`src/components/LinkedRecords.tsx`)

`<LinkedRecords kind id onNavigate />` loads every connection and renders each one as a jump link. Cmd/Ctrl-click opens a new tab. Deleted records are listed but greyed out and can't be clicked. It appears in:

- **Lot** (Inventory → a lot's "Purchase Tx" cell): purchase transactions, cost-adjustment transactions, sales that consumed the lot (`inventory_movements`), the trade it was received in, the breakdown that created it, and breakdowns it was split into.
- **Sale** detail: lots it consumed, its transactions (`related_sale_id`), bundle, trade.
- **Transaction** detail: lots it funds (`inventory_lot_transactions`) or adjusts (`lot_cost_adjustments`), sale, bundle, trade, breakdowns, net-zero partner.
- **Bundle**: its sales, the lots those sales used, its transactions (`related_bundle_id`).
- **Trade**: sales given, lots received, transactions (`trade_id`).
- **Breakdown**: source lot, resulting lots, transaction.

`onNavigate` closes the current panel before jumping. The jump is an ordinary navigation, so Back returns to the previous page.
