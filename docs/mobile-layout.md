# Mobile layout

The web client is used on phones as well as desktops. Below Tailwind's `md` breakpoint (768px) the app uses a phone layout. **Rule: no page may scroll sideways at 320px or wider.** Desktop (`md`+) layouts are unchanged.

## Shell (`src/components/Layout.tsx`)

- **Bottom tab bar:** four primary tabs (Dashboard, Sales, Inventory, Expenses) plus **More**. More opens a bottom sheet with Bundles, Trades, Breakdowns, Settings, and Sign Out. iOS guidance caps a tab bar at 5 items; the old 8-tab bar gave each tab about 47px at 375px, so labels overlapped and Settings was cut off. The More tab is highlighted when the current route is one of its pages. To promote or demote a page, edit `MOBILE_PRIMARY`.
- The shell uses `h-dvh` (not `h-screen`), so iOS Safari's collapsing URL bar doesn't hide the tab bar.
- `<main>` has `overflow-x-hidden` and `html, body` have `overflow-x: hidden` **as a backstop only**. Pages must still fit on their own: the clip hides overflow but doesn't fix it (content that's cut off can't be reached).
- Z-order: tab bar and More sheet `z-30` < `SlideOver` `z-40` < `Modal` `z-50` < `ConfirmDialog`/`InfoPopover` `z-[60]`.

## Overlays

- **`Modal`** is a bottom sheet on phones (full width, `rounded-t-2xl`, `max-h-[92dvh]`, safe-area bottom padding) and a centered card from `sm` up.
- **`SlideOver`** is full width on phones: its `width` prop is capped by `max-w-full`.
- **`InfoPopover`** is pinned to the viewport on phones (`fixed inset-x-4`), so it can't spill off either edge.
- **`CategoryDropdown`** is capped at `100vw - 2rem`. In Expenses, the floating per-row dropdown position is clamped into the viewport and opens upward near the bottom of the screen.
- **Line-item grids** in RecordSale, RecordTrade, OpenBox, and EditBundle modals: on phones the item/name cell spans the first row, with qty/price/delete on the row below. From `sm` up the original single-row layout returns. Fixed columns like `[1fr_70px_100px_28px]` squeezed the name cell to about 10px at 320px.

## Pages: tables become cards below `md`

Every data table renders twice: a `md:hidden` card list and a `hidden md:table` table. Both are driven by the same filtered/sorted array, so totals and filters can't drift apart. **If you add a column or row action to a table, add it to the card too.**

| Page | Phone card shows |
| --- | --- |
| Sales | item name (2-line clamp), date · platform · Trade/Bundle pills · non-OK inventory status · return status, price + net payout, "Link to inventory" when unlinked |
| Expenses | Dense two-line rows (~59px): checkbox · merchant · signed amount, then category badge (tap → picker) · short date · account. Notes, non-cash and settlement tags are only in the detail panel |
| Inventory — By Item | item name, category · units in stock · lot count, value + avg cost. Tap to expand into edit/delete-item actions, lot cards, and "Add purchase lot" |
| Inventory — By Date | `MobileLotCard` with item name, full lot cost |
| Bundles | platform · item count, date, order ID (`break-all`), net payout |
| Trades | counterparty, date, boot, Gave/Received tiles |

Other phone-specific behavior:

- **Row actions always visible.** The desktop tables reveal edit/delete/add-cost on hover, which doesn't exist on touch screens. `MobileLotCard` and the expanded item card always show those buttons, and `BasisLines` takes `alwaysShowDelete`.
- **Expenses scrolls as one page on phones.** The header (period, search, filters) scrolls away, so about 11–12 rows fit on screen versus about 7 under a fixed header. From `md` up the header stays fixed and only the table scrolls. Because the page scrolls this way, the bulk-action bar is `fixed` above the tab bar on phones. The floating category picker closes on any scroll outside itself (`data-cat-dd`), so it never drifts away from its row.
- **Expenses filters** collapse behind a **Filters (n)** toggle, where n counts active filters. Phones get a sort `<select>` in that panel because they have no sortable column headers.
- **Headers** use `p-4 md:p-6` and `flex-wrap`. Search inputs are full width. Inventory's three actions become a 3-column grid with short labels (Trade / Breakdown / Item).
- **Dashboard:** KPI grid is 2 columns (Net spans full width) and becomes 3 columns from `sm` up. Profitability and Schedule C cards stack (their side-by-side layout starts at `md`). The Schedule C card isn't height-capped on phones, so there's no nested scroll.

## iOS input zoom

`src/index.css` sets `font-size: 16px` on `input`/`select`/`textarea` below 768px. iOS Safari zooms in when a focused field is under 16px and doesn't zoom back out, which leaves the page wider than the screen. The rule is unlayered on purpose so it beats Tailwind's `text-sm` utilities.

## Verifying

There's no automated test for this. To check by hand: run `npm run dev`, use device emulation at 320/375/430px, and on each page confirm that `document.documentElement.scrollWidth === innerWidth` and that no `overflow-y-auto` container has `scrollWidth > clientWidth`. Do the same with slide-overs and modals open.
