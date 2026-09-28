# Trades Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `/trades` top-level page showing all trades as a table, replacing the current approach where trades are only discoverable via lot pills on the Inventory page.

**Architecture:** Three file changes + one new file. Add `useTrades()` query hook (key `['trades']`) and add `['trades']` invalidation to the two mutation sites. New `TradesPage.tsx` renders a table with color-coded boot column. Layout + App wired for nav and routing.

**Tech Stack:** Vite + React 19 + TypeScript, TanStack React Query, Tailwind v4, Supabase JS, React Router v7, Lucide React.

---

## Files

| Action | File |
|---|---|
| Modify | `src/lib/queries.ts` — add `useTrades()` |
| Modify | `src/components/modals/RecordTradeModal.tsx` — add `['trades']` invalidation |
| Modify | `src/components/TradeDetailSlideOver.tsx` — add `['trades']` invalidation |
| Create | `src/pages/TradesPage.tsx` |
| Modify | `src/components/Layout.tsx` — add `ArrowLeftRight` import + nav entry |
| Modify | `src/App.tsx` — add `/trades` route |

---

### Task 1: Add `useTrades()` and wire cache invalidations

**Files:**
- Modify: `src/lib/queries.ts` (add after `useBundles`, or after `useBoxOpeningsWithItems` if `useBundles` not yet present)
- Modify: `src/components/modals/RecordTradeModal.tsx` (line 106, in `onSuccess`)
- Modify: `src/components/TradeDetailSlideOver.tsx` (line 26, in `onSuccess`)

- [ ] **Step 1: Add `useTrades()` to `src/lib/queries.ts`**

Open `src/lib/queries.ts`. Find the end of the `useBundles` function (or after `useBoxOpeningsWithItems` if `useBundles` is not present). Insert:

```typescript
/** All trades for the current user, newest-first. */
export function useTrades() {
  return useQuery({
    queryKey: ['trades'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trades')
        .select('id, traded_at, counterparty, given_fmv, received_fmv, cash_boot')
        .is('deleted_at', null)
        .order('traded_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as {
        id: string
        traded_at: string
        counterparty: string | null
        given_fmv: number | null
        received_fmv: number | null
        cash_boot: number | null
      }[]
    },
  })
}
```

- [ ] **Step 2: Add `['trades']` invalidation to `RecordTradeModal.tsx`**

Open `src/components/modals/RecordTradeModal.tsx`. Find the `onSuccess` handler around line 102 that currently has:
```typescript
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['trade'] })
      reset()
      onClose()
```
Add one line after `['trade']` and before `reset()`:
```typescript
      qc.invalidateQueries({ queryKey: ['trades'] })
```

- [ ] **Step 3: Add `['trades']` invalidation to `TradeDetailSlideOver.tsx`**

Open `src/components/TradeDetailSlideOver.tsx`. Find the `del` mutation `onSuccess` around line 22 that currently has:
```typescript
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['trade'] })
      setConfirmDelete(false)
      onClose()
```
Add one line after `['trade']` and before `setConfirmDelete`:
```typescript
      qc.invalidateQueries({ queryKey: ['trades'] })
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Run tests**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: 78 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries.ts src/components/modals/RecordTradeModal.tsx src/components/TradeDetailSlideOver.tsx
git commit -m "feat: add useTrades query and wire cache invalidations"
```

---

### Task 2: Create `src/pages/TradesPage.tsx`

**Files:**
- Create: `src/pages/TradesPage.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useState } from 'react'
import { formatUSD, formatDate } from '../lib/utils'
import { useTrades } from '../lib/queries'
import TradeDetailSlideOver from '../components/TradeDetailSlideOver'

function formatBoot(cash_boot: number | null): { text: string; className: string } {
  if (cash_boot == null || cash_boot === 0) return { text: '—', className: 'text-gray-400' }
  if (cash_boot > 0) return { text: `+${formatUSD(cash_boot)}`, className: 'text-green-600 font-medium' }
  return { text: formatUSD(cash_boot), className: 'text-red-600 font-medium' }
}

export default function TradesPage() {
  const [openTradeId, setOpenTradeId] = useState<string | null>(null)
  const { data: trades = [], isLoading } = useTrades()

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 bg-white">
        <h1 className="text-lg font-semibold text-gray-900">Trades</h1>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : trades.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            No trades yet. Use &#39;Record Trade&#39; on the Inventory page to log one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Date</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Counterparty</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Gave</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Received</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Boot</th>
              </tr>
            </thead>
            <tbody>
              {trades.map(t => {
                const boot = formatBoot(t.cash_boot)
                return (
                  <tr
                    key={t.id}
                    onClick={() => setOpenTradeId(t.id)}
                    className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5 text-gray-600 tabular-nums">{formatDate(t.traded_at)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{t.counterparty ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">
                      {t.given_fmv != null ? formatUSD(t.given_fmv) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">
                      {t.received_fmv != null ? formatUSD(t.received_fmv) : '—'}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${boot.className}`}>
                      {boot.text}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
        {trades.length} {trades.length === 1 ? 'trade' : 'trades'}
      </div>

      <TradeDetailSlideOver tradeId={openTradeId} onClose={() => setOpenTradeId(null)} />
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors (or only "TradesPage not found in routes" if Layout/App not wired yet — that's OK).

- [ ] **Step 3: Commit**

```bash
git add src/pages/TradesPage.tsx
git commit -m "feat: add TradesPage with table layout"
```

---

### Task 3: Add Trades nav item and route

**Files:**
- Modify: `src/components/Layout.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `ArrowLeftRight` to Layout.tsx import and add nav entry**

In `src/components/Layout.tsx`, find the lucide-react import line. It will look like one of:
```typescript
import { LayoutDashboard, ShoppingCart, ShoppingBag, Package, PackageOpen, Receipt, Settings, LogOut } from 'lucide-react'
```
Add `ArrowLeftRight` to the import:
```typescript
import { LayoutDashboard, ShoppingCart, ShoppingBag, ArrowLeftRight, Package, PackageOpen, Receipt, Settings, LogOut } from 'lucide-react'
```

Find the `NAV` array and add Trades after the Inventory entry (`{ to: '/inventory', ... }`):
```typescript
const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sales', icon: ShoppingCart, label: 'Sales' },
  { to: '/bundles', icon: ShoppingBag, label: 'Bundles' },
  { to: '/inventory', icon: Package, label: 'Inventory' },
  { to: '/trades', icon: ArrowLeftRight, label: 'Trades' },
  { to: '/breakdowns', icon: PackageOpen, label: 'Breakdowns' },
  { to: '/expenses', icon: Receipt, label: 'Expenses' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]
```

- [ ] **Step 2: Add route and import in `src/App.tsx`**

Find the last page import before the component (look for `BundlesPage` import or `BreakdownsPage` import). Add after it:
```typescript
import TradesPage from './pages/TradesPage'
```

Find the `/bundles` route (or `/inventory` route if `/bundles` isn't present yet). Add the trades route after bundles:
```typescript
              <Route path="/bundles" element={<BundlesPage />} />
              <Route path="/trades" element={<TradesPage />} />
```

If `/bundles` route is not present yet, add after `/inventory`:
```typescript
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/trades" element={<TradesPage />} />
```

- [ ] **Step 3: Verify clean build**

```bash
npm run build 2>&1 | head -20
```

Expected: **zero TypeScript errors**.

- [ ] **Step 4: Run tests**

```bash
npx vitest run 2>&1 | tail -5
```

Expected: 78 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/Layout.tsx src/App.tsx
git commit -m "feat: add Trades nav item and route"
```

---

## Manual Verification Checklist

- [ ] Nav shows Trades between Inventory and Breakdowns
- [ ] `/trades` loads the Trades page
- [ ] All trades appear as table rows (date, counterparty, gave FMV, received FMV, boot)
- [ ] Boot column: green `+$X` when positive, red when negative, `—` when null or 0
- [ ] Clicking a row opens `TradeDetailSlideOver`
- [ ] Empty state shows when no trades exist
- [ ] Footer count correct ("N trades")
- [ ] After recording a new trade, Trades page refreshes (cache invalidation works)
- [ ] After deleting a trade from the slide-over, it disappears from the list
