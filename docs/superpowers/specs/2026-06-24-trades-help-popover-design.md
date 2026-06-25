# Trades Help Popover — Design

**Status:** Draft — awaiting user review
**Date:** 2026-06-24
**Author:** Brainstormed with Claude

## Background

The trades feature shipped in commits `100225e..3ee824c` introduces non-trivial accounting concepts: fair market value as transaction anchor, the canonical Schedule C wash rule, cash boot direction semantics, and the "delete + re-record" edit path. First-time users (including the product owner months from now) will need a refresher.

This spec adds a small in-modal help affordance to `RecordTradeModal` so the rules are accessible exactly when the user is filling in a trade — no need to leave the modal or hunt through docs.

Scope is intentionally narrow: just trades, just the record modal. A reusable `InfoPopover` primitive lets the pattern extend to other features later, but we don't add it elsewhere in this pass.

## Approach

Build a small reusable popover primitive (`<InfoPopover>`) and use it once in `RecordTradeModal` with hardcoded trade-specific content. The primitive is so small (~40 lines) that the abstraction cost is essentially zero, and it keeps `RecordTradeModal` from absorbing popover state and outside-click logic.

## Component: `InfoPopover`

**File (new):** `src/components/InfoPopover.tsx`

**Props:**

```ts
interface Props {
  children: React.ReactNode    // popover content
  label?: string               // aria-label for the trigger button; default "More info"
  width?: string               // tailwind width class for the panel; default "w-80"
}
```

**Behavior:**

- Renders a `<button type="button">` with the `Info` icon from `lucide-react` (`size={14}`, gray, hover darker — matches the existing icon-button visual language used in `Modal.tsx`'s close button).
- Click toggles an absolutely-positioned panel anchored to the right edge of the trigger.
- Panel closes on:
  - Pressing **Escape** (document-level keydown listener, only registered while open)
  - Clicking outside the panel (document-level mousedown listener, only registered while open)
  - Clicking the trigger again
- Panel styling (Tailwind): white background, `border border-gray-200`, `rounded-lg`, `shadow-lg`, `p-4`, `text-xs text-gray-700`, `max-h-[400px] overflow-y-auto`.
- z-index: `z-[60]` — above the modal it lives inside (`Modal.tsx` uses `z-50`).
- The button has `type="button"` so it doesn't submit the surrounding form.
- The panel is rendered as a sibling to the trigger inside a wrapping `<span className="relative inline-block">` so positioning is local to the trigger.

**No dependencies on portals, downshift, headlessui, etc.** Pure React + Tailwind, consistent with the rest of the codebase.

## Integration: `RecordTradeModal`

**File (modified):** `src/components/modals/RecordTradeModal.tsx`

**Placement:** at the top of the `<form>` body, before the date/counterparty grid. A small flex row right-aligns the popover trigger above the form content:

```tsx
<div className="flex justify-end -mt-2 mb-2">
  <InfoPopover label="How trades work" width="w-[360px]">
    <HelpContent />
  </InfoPopover>
</div>
```

**Why this placement and not next to the modal title:** the `Modal` primitive accepts `title: string` (not `ReactNode`). Extending `Modal`'s API for a single consumer adds surface area for no real gain. The top-right of the form body is the next-best location — still high in the visual hierarchy, doesn't require touching the shared `Modal` component, and works visually as a "show me how this works" affordance just before the user starts filling fields.

**`HelpContent` component:** a small local component defined at the bottom of `RecordTradeModal.tsx` (same file — only consumer; no need for its own file). Renders the trade-help body as JSX. No props.

## Content

Rendered inside `HelpContent`. Markdown shown here for readability; in JSX it will be paragraphs, a list, and a 3-column table using existing Tailwind classes for type and spacing.

```
Recording a trade

A trade is treated as a barter sale under IRS rules — both sides are recorded
at fair market value (FMV), and the trade itself anchors the transaction price.

You gave — items leaving your inventory. Each becomes a Sale at the FMV you
enter, FIFO-depleting the underlying lot.

You received — items entering your inventory. Each becomes a new lot with cost
basis = the FMV you enter. Pick an existing item or create a new one inline.

Cash boot — optional cash that balances the trade. The balance rule is:

  Given total + cash you paid = Received total + cash you received

The balance footer turns green when this holds. Submit is disabled otherwise.

What gets posted to Schedule C:

| Component       | Amount                 | Cash?         |
|-----------------|------------------------|---------------|
| Non-cash income | given − cash received  | non-cash      |
| Non-cash COGS   | same (always washes)   | non-cash      |
| Cash boot       | signed                 | real bank txn |

The two non-cash legs cancel each other; only the cash boot moves your Schedule C
totals at trade time. The deferred gain materializes later when received items
are sold.

FMV source notes — recommended for IRS defensibility. Save a quick reference
(e.g. "eBay sold comps screenshot 2026-06-24").

Editing — trades are read-only after creation. To change one, delete it from
the Trade detail drawer and re-record. Delete blocks if you've already sold
any received items.
```

JSX rendering uses:
- `<h3>` for section headings (text-sm font-semibold)
- `<p>` for body (text-xs)
- `<table>` for the 3-column rule table (mirrors the slide-over's table styling)
- The "Given total + cash you paid = Received total + cash you received" line gets `<code>` or a `bg-gray-50 px-2 py-1 rounded` block for emphasis

## Out of scope (v1)

- Help on the `TradeDetailSlideOver` (could add later if useful)
- Help on the Inventory page's "Record Trade" button before opening the modal
- Help across other features (Sales, Inventory, Expenses, Dashboard) — separate effort if/when desired
- Markdown rendering (content is hand-written JSX; no markdown-to-JSX dependency)
- Searchable / indexed help content
- Internationalization (English only)
- Analytics on popover open events

## Documentation updates (same PR)

Per CLAUDE.md doc-maintenance rule:

- `docs/features/inventory.md` — add a sentence under the Record Trade section noting the in-modal help popover and what it covers
- No other doc updates needed (no schema change, no mutation/query change)

## Success criteria

- Clicking the info button in `RecordTradeModal` opens the help panel anchored to the button's right edge, visually above the modal contents (z-index correct).
- Pressing Escape, clicking outside the panel, or clicking the trigger again closes the panel.
- The button is keyboard-focusable and has a clear aria-label ("How trades work").
- The popover does NOT submit the form when clicked.
- Content matches the spec text above (no placeholder, no Lorem ipsum).
- `npm run build` clean, no new TypeScript warnings.
- `docs/features/inventory.md` mentions the help popover.
