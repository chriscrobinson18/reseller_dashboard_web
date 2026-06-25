# Trades Help Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-modal "i" info button to `RecordTradeModal` that explains the trade flow, balance rule, Schedule C wash, and edit path via a click-to-open popover.

**Architecture:** New reusable `InfoPopover` primitive (~40 lines, pure React + Tailwind, no portals or third-party popover libs). Used once in `RecordTradeModal` with hardcoded JSX help content. Doc update in `docs/features/inventory.md`.

**Tech Stack:** React 19, TypeScript, Tailwind v4, `lucide-react` for the Info icon. No test suite per CLAUDE.md.

**Spec:** [`docs/superpowers/specs/2026-06-24-trades-help-popover-design.md`](../specs/2026-06-24-trades-help-popover-design.md).

---

## File map

**Create:**
- `src/components/InfoPopover.tsx`

**Modify:**
- `src/components/modals/RecordTradeModal.tsx`
- `docs/features/inventory.md`

---

## Task 1: `InfoPopover` primitive

**Files:**
- Create: `src/components/InfoPopover.tsx`

- [ ] **Step 1: Create the component file.**

```tsx
import { useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'

interface Props {
  children: React.ReactNode
  label?: string
  width?: string
}

/**
 * Click-to-open popover anchored to an Info icon trigger. Closes on Escape,
 * outside click, or re-click of the trigger.
 *
 * Renders panel with z-[60] so it sits above z-50 Modal it may live inside.
 */
export default function InfoPopover({ children, label = 'More info', width = 'w-80' }: Props) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  return (
    <span ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={label}
        aria-expanded={open}
        className="text-gray-400 hover:text-gray-700 p-1 rounded inline-flex items-center"
      >
        <Info size={14} />
      </button>
      {open && (
        <div
          className={`absolute right-0 top-full mt-1 ${width} bg-white border border-gray-200 rounded-lg shadow-lg p-4 text-xs text-gray-700 max-h-[400px] overflow-y-auto z-[60]`}
          role="dialog"
          aria-label={label}
        >
          {children}
        </div>
      )}
    </span>
  )
}
```

- [ ] **Step 2: Typecheck.**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add src/components/InfoPopover.tsx
git commit -m "feat: InfoPopover primitive (click-to-open info panel)"
```

---

## Task 2: Wire help popover into `RecordTradeModal`

**Files:**
- Modify: `src/components/modals/RecordTradeModal.tsx`

- [ ] **Step 1: Read current state of the file.**

Open `src/components/modals/RecordTradeModal.tsx` and locate the `<form onSubmit={submit}>` opening tag and the first inner `<div className="grid grid-cols-2 gap-3">` (the date/counterparty grid). The new help row goes between them.

- [ ] **Step 2: Add the import for `InfoPopover` near the top of the file.**

Add to the existing imports:

```tsx
import InfoPopover from '../InfoPopover'
```

(Place it alphabetically with the other relative imports — e.g. between `Modal` and `ItemPicker` if those are present.)

- [ ] **Step 3: Add the `HelpContent` local component at the bottom of the file.**

After the `export default function RecordTradeModal(...)` definition closes (after its final `}`), append:

```tsx
function HelpContent() {
  return (
    <div className="space-y-3 leading-relaxed">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Recording a trade</h3>
        <p>
          A trade is treated as a barter sale under IRS rules — both sides are recorded at fair
          market value (FMV), and the trade itself anchors the transaction price.
        </p>
      </div>

      <div>
        <p>
          <strong>You gave</strong> — items leaving your inventory. Each becomes a Sale at the FMV you
          enter, FIFO-depleting the underlying lot.
        </p>
      </div>

      <div>
        <p>
          <strong>You received</strong> — items entering your inventory. Each becomes a new lot with
          cost basis = the FMV you enter. Pick an existing item or create a new one inline.
        </p>
      </div>

      <div>
        <p>
          <strong>Cash boot</strong> — optional cash that balances the trade. The balance rule is:
        </p>
        <pre className="mt-1 bg-gray-50 px-2 py-1.5 rounded text-[11px] whitespace-pre-wrap">
Given total + cash you paid = Received total + cash you received
        </pre>
        <p className="mt-1">
          The balance footer turns green when this holds. Submit is disabled otherwise.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">What gets posted to Schedule C</h3>
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 pr-2 font-medium">Component</th>
              <th className="py-1 pr-2 font-medium">Amount</th>
              <th className="py-1 font-medium">Cash?</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-gray-100">
              <td className="py-1 pr-2">Non-cash income</td>
              <td className="py-1 pr-2">given − cash received</td>
              <td className="py-1">non-cash</td>
            </tr>
            <tr className="border-t border-gray-100">
              <td className="py-1 pr-2">Non-cash COGS</td>
              <td className="py-1 pr-2">same (always washes)</td>
              <td className="py-1">non-cash</td>
            </tr>
            <tr className="border-t border-gray-100">
              <td className="py-1 pr-2">Cash boot</td>
              <td className="py-1 pr-2">signed</td>
              <td className="py-1">real bank txn</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-1">
          The two non-cash legs cancel each other; only the cash boot moves your Schedule C totals
          at trade time. The deferred gain materializes later when received items are sold.
        </p>
      </div>

      <div>
        <p>
          <strong>FMV source notes</strong> — recommended for IRS defensibility. Save a quick
          reference (e.g. "eBay sold comps screenshot 2026-06-24").
        </p>
      </div>

      <div>
        <p>
          <strong>Editing</strong> — trades are read-only after creation. To change one, delete it
          from the Trade detail drawer and re-record. Delete blocks if you've already sold any
          received items.
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add the popover row at the top of the form body.**

Inside `RecordTradeModal`'s render, find the `<form onSubmit={submit}>` block. Immediately after the opening `<form ...>` tag, before the first existing child element (the date/counterparty grid), add:

```tsx
<div className="flex justify-end -mt-2 mb-2">
  <InfoPopover label="How trades work" width="w-[360px]">
    <HelpContent />
  </InfoPopover>
</div>
```

- [ ] **Step 5: Typecheck.**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add src/components/modals/RecordTradeModal.tsx
git commit -m "feat(trades): in-modal help popover explaining the trade flow"
```

---

## Task 3: Doc update

**Files:**
- Modify: `docs/features/inventory.md`

- [ ] **Step 1: Add a sentence about the help popover.**

Open `docs/features/inventory.md` and find the section that documents the Record Trade flow (added in the trades feature PR — likely titled "Recording a trade" or similar). At the end of the `RecordTradeModal` description (or as a new bullet), add:

```markdown
A small **info** button at the top-right of the modal opens an in-place help popover covering: the FMV-anchored barter rule, the balance equation (given + cash paid = received + cash received), the Schedule C wash for the two non-cash legs, FMV-source-note defensibility, and the delete-and-re-record edit path.
```

If the section doesn't exist yet, add it after the existing inventory feature sections. If a similar sentence already exists, edit in place rather than duplicating.

- [ ] **Step 2: Commit.**

```bash
git add docs/features/inventory.md
git commit -m "docs(trades): note the in-modal help popover"
```

---

## Done

After Task 3, the help popover is live and documented. Run `npm test` to confirm the existing test suite still passes (it should — no logic changes touched anything tested).
