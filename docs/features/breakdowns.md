# Breakdowns Page

> Route: `/breakdowns` · Component: `src/pages/BreakdownsPage.tsx`

Shows every box breakdown (open and closed) as a card. Each card always displays its child items inline — no expand needed.

## Data

`useBoxOpeningsWithItems()` (`src/lib/queries.ts`) — query key `['box-openings']`. Selects `box_openings` with embedded `inventory_lots(id, unit_cost, deleted_at, items(id, name))`. Filters `deleted_at IS NULL` on the parent row; child lots are filtered client-side for `!l.deleted_at`.

Derived fields per row:
- `pullCount` — count of non-deleted child lots
- `allocated` — sum of `unit_cost` across non-deleted lots
- `remainingBasis` — `box_cost - allocated`, null when closed or when `box_cost` is null

## Sort order

Open breakdowns first (by `opened_at` desc), then closed (by `opened_at` desc). Computed in `useMemo` in the component.

## Card layout

Each breakdown renders as a card:
- **Header**: box name, opened_at date, status badge (amber "In Progress" / gray "Closed"), box_cost
- **Body**: one row per child lot — item name (left) + unit_cost (right). Shows "No pulls yet" if pullCount === 0.
- **Footer** (open only, box_cost non-null): "Pool remaining: $X.XX of $Y.YY" — green when remaining < $0.01

Clicking any card opens `BoxOpeningDetailSlideOver` (the existing slide-over, shared with Inventory).

## Cache invalidation

All mutations that modify `box_openings` data invalidate `['box-openings']`:
- `openBox`, `startBoxOpening` — in `src/components/modals/OpenBoxModal.tsx`
- `addPullToOpening` — in `src/components/modals/AddPullModal.tsx`
- `closeBoxOpening`, `deleteBoxOpening` — in `src/components/BoxOpeningDetailSlideOver.tsx`
- `deleteIncompleteBreakdown` — in `src/pages/InventoryPage.tsx`

## Incomplete breakdowns

Breakdowns with no `source_lot_id` (created before the source lot was linked) appear in the Inventory page banner ("⚠️ N breakdowns need completion"). They also appear on this page with "No pulls yet" if they have no child lots. The Inventory banner is the primary call-to-action for completing them.
