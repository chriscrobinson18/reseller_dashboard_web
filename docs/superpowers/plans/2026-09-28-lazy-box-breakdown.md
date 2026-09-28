# Lazy Box Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow box breakdowns to be built incrementally — one pull at a time as cards are sold — instead of requiring all cards to be planned upfront.

**Architecture:** Add a `status` column to `box_openings` (`'open' | 'closed'`). Three new mutations (`startBoxOpening`, `addPullToOpening`, `closeBoxOpening`) handle the lazy path. The existing `openBox()` is unchanged except it now passes `status: 'closed'` explicitly. `BoxOpeningDetailSlideOver` gets the active-pool UI (pool balance, Add Pull button, Close Box button). `OpenBoxModal` gets a second entry point ("Start — Add As I Pull") that creates an empty open breakdown.

**Tech Stack:** Supabase (SQL migration + JS client), TypeScript, React 19, TanStack React Query, Tailwind v4, Lucide icons.

---

## Files

| Action | File |
|---|---|
| Create | `supabase/migrations/20260928120000_lazy_box_breakdown.sql` |
| Modify | `src/lib/types.ts` |
| Modify | `src/lib/mutations.ts` |
| Modify | `src/lib/queries.ts` |
| Create | `src/components/modals/AddPullModal.tsx` |
| Modify | `src/components/BoxOpeningDetailSlideOver.tsx` |
| Modify | `src/components/modals/OpenBoxModal.tsx` |
| Modify | `docs/features/inventory.md` |

---

### Task 1: Migration — add `status` column to `box_openings`

**Files:**
- Create: `supabase/migrations/20260928120000_lazy_box_breakdown.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260928120000_lazy_box_breakdown.sql

-- Add status column. Default 'open' so newly inserted rows are open by default.
-- openBox() will explicitly pass 'closed' to keep the all-at-once flow closed.
alter table public.box_openings
  add column status text not null default 'open'
  check (status in ('open', 'closed'));

-- All existing breakdowns were finalized upfront — mark them closed.
update public.box_openings
set status = 'closed'
where deleted_at is null;
```

- [ ] **Step 2: Apply the migration via Supabase MCP**

> ⚠️ **Important:** The box_openings table has a known migration history issue (`20260803120000` and `20260803130000` were applied directly and aren't tracked in `schema_migrations`). Do NOT use `supabase db push` — apply this via the Supabase MCP `apply_migration` tool or the SQL editor.

Run in Supabase SQL editor or via `mcp__supabase__apply_migration`:
```sql
alter table public.box_openings
  add column status text not null default 'open'
  check (status in ('open', 'closed'));

update public.box_openings
set status = 'closed'
where deleted_at is null;
```

- [ ] **Step 3: Verify**

Run in SQL editor:
```sql
select status, count(*) from box_openings group by status;
```
Expected: one row with `status = 'closed'` and whatever count of existing breakdowns (could be 0 if no breakdowns exist yet). No `'open'` rows yet.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260928120000_lazy_box_breakdown.sql
git commit -m "feat: add status column to box_openings for lazy breakdown mode"
```

---

### Task 2: Update TypeScript type — `BoxOpening.status`

**Files:**
- Modify: `src/lib/types.ts` (around line 228 — the `BoxOpening` interface)

- [ ] **Step 1: Add `status` field to `BoxOpening`**

Find the `BoxOpening` interface (currently ends at line ~230). Add `status` as the last field before the closing brace:

```typescript
export interface BoxOpening {
  id: string
  user_id: string
  created_at: string
  deleted_at?: string | null
  opened_at: string                          // 'yyyy-MM-dd'
  box_name: string
  box_cost: number | null
  transaction_id: string | null
  allocation_method: BoxAllocationMethod | null
  /** The inventory_lots row this box was opened from. */
  source_lot_id: string | null
  /** How many units of the source lot were opened (usually 1). */
  quantity: number
  notes?: string | null
  /** 'open' = lazy breakdown in progress; 'closed' = finalized. */
  status: 'open' | 'closed'
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add status field to BoxOpening type"
```

---

### Task 3: Mutations — update `openBox()` + add 3 new mutations

**Files:**
- Modify: `src/lib/mutations.ts`

This task adds three new exported functions and one small change to the existing `openBox()` function. Add the three new functions directly after `deleteBoxOpening`.

- [ ] **Step 1: Update `openBox()` to explicitly pass `status: 'closed'`**

In `openBox()`, find the `box_openings` insert (around line 198). The current insert does NOT include `status`, which means the DB default `'open'` applies. Fix it by adding `status: 'closed'` explicitly:

```typescript
  const { data: opening, error: openingErr } = await supabase
    .from('box_openings')
    .insert({
      user_id,
      opened_at: params.openedAt,
      box_name: params.quantity > 1 ? `${boxName} ×${params.quantity}` : boxName,
      box_cost: boxCost,
      transaction_id: sourceLot.transaction_id ?? null,
      allocation_method: params.allocationMethod,
      source_lot_id: params.sourceLotId,
      quantity: params.quantity,
      notes: params.notes ?? null,
      status: 'closed',              // ← add this line
    })
    .select('id')
    .single()
```

- [ ] **Step 2: Add `startBoxOpening` after `deleteBoxOpening`**

Add this function to `mutations.ts` after the closing brace of `deleteBoxOpening`:

```typescript
/**
 * Starts a lazy breakdown: creates an 'open' box_openings row with no child
 * lots and immediately depletes the source lot. Cards are added later via
 * addPullToOpening(). Call closeBoxOpening() when done to write off remaining
 * basis to COGS.
 */
export async function startBoxOpening(params: {
  sourceLotId: string
  openedAt: string     // 'yyyy-MM-dd'
  notes?: string | null
}): Promise<{ boxOpeningId: string }> {
  const user_id = await getUserId()

  const { data: sourceLot, error: sourceErr } = await supabase
    .from('inventory_lots')
    .select('id, unit_cost, quantity_remaining, transaction_id, items(name)')
    .eq('id', params.sourceLotId)
    .is('deleted_at', null)
    .single()
  if (sourceErr || !sourceLot) throw sourceErr ?? new Error('Source lot not found')
  if (sourceLot.quantity_remaining < 1) throw new Error('Source lot has no remaining stock')

  const boxCost = Number(sourceLot.unit_cost.toFixed(2))
  const boxName = (sourceLot.items as unknown as { name: string } | null)?.name ?? 'Box'

  const { error: depleteErr } = await supabase
    .from('inventory_lots')
    .update({ quantity_remaining: sourceLot.quantity_remaining - 1 })
    .eq('id', params.sourceLotId)
  if (depleteErr) throw depleteErr

  const { data: opening, error: openingErr } = await supabase
    .from('box_openings')
    .insert({
      user_id,
      opened_at: params.openedAt,
      box_name: boxName,
      box_cost: boxCost,
      transaction_id: sourceLot.transaction_id ?? null,
      allocation_method: null,
      source_lot_id: params.sourceLotId,
      quantity: 1,
      notes: params.notes ?? null,
      status: 'open',
    })
    .select('id')
    .single()
  if (openingErr || !opening) throw openingErr ?? new Error('Failed to create box opening')

  return { boxOpeningId: opening.id }
}
```

- [ ] **Step 3: Add `addPullToOpening` after `startBoxOpening`**

```typescript
/**
 * Adds one card lot to an open lazy breakdown. Creates a child inventory_lots
 * row with the given basis and mirrors the source lot's transaction funding
 * link if one exists.
 *
 * Throws if basis exceeds the remaining pool balance.
 */
export async function addPullToOpening(params: {
  boxOpeningId: string
  itemId?: string | null
  newItemName?: string | null
  newItemCategory?: string | null
  basis: number
}): Promise<{ lotId: string }> {
  const user_id = await getUserId()

  const { data: opening, error: openingErr } = await supabase
    .from('box_openings')
    .select('id, box_cost, opened_at, status, source_lot_id, transaction_id')
    .eq('id', params.boxOpeningId)
    .is('deleted_at', null)
    .single()
  if (openingErr || !opening) throw openingErr ?? new Error('Box opening not found')
  if (opening.status !== 'open') throw new Error('This breakdown is already closed')

  const { data: existingLots, error: lotsErr } = await supabase
    .from('inventory_lots')
    .select('unit_cost')
    .eq('box_opening_id', params.boxOpeningId)
    .is('deleted_at', null)
  if (lotsErr) throw lotsErr
  const allocated = (existingLots ?? []).reduce((sum, l) => sum + l.unit_cost, 0)
  const remaining = Number(((opening.box_cost ?? 0) - allocated).toFixed(2))
  if (params.basis > remaining + 0.01) {
    throw new Error(`Basis $${params.basis.toFixed(2)} exceeds remaining pool $${remaining.toFixed(2)}`)
  }

  let itemId = params.itemId ?? null
  if (!itemId) {
    if (!params.newItemName?.trim()) throw new Error('Item is required')
    const { data: newItem, error: newItemErr } = await supabase
      .from('items')
      .insert({ user_id, name: params.newItemName.trim(), category: params.newItemCategory ?? null })
      .select('id')
      .single()
    if (newItemErr || !newItem) throw newItemErr ?? new Error('Failed to create item')
    itemId = newItem.id
  }

  const { data: lotRow, error: lotErr } = await supabase
    .from('inventory_lots')
    .insert({
      user_id,
      item_id: itemId,
      transaction_id: opening.transaction_id ?? null,
      box_opening_id: params.boxOpeningId,
      quantity_purchased: 1,
      quantity_remaining: 1,
      unit_cost: params.basis,
      initial_unit_cost: params.basis,
      purchase_date: opening.opened_at,
    })
    .select('id')
    .single()
  if (lotErr || !lotRow) throw lotErr ?? new Error('Failed to create card lot')

  if (opening.transaction_id) {
    const { error: linkErr } = await supabase
      .from('inventory_lot_transactions')
      .insert({
        user_id,
        lot_id: lotRow.id,
        transaction_id: opening.transaction_id,
        allocated_amount: params.basis,
      })
    if (linkErr) throw linkErr
  }

  return { lotId: lotRow.id }
}
```

- [ ] **Step 4: Add `closeBoxOpening` after `addPullToOpening`**

```typescript
/**
 * Finalizes a lazy breakdown. If any pool basis remains unallocated (the bulk
 * cards that won't be sold), inserts a transactions row to write off that
 * amount as cost_of_goods on Schedule C, then marks the opening closed.
 *
 * Safe to call when remaining === 0 (no transaction is created).
 */
export async function closeBoxOpening(boxOpeningId: string): Promise<{ remainingAmount: number }> {
  const user_id = await getUserId()

  const { data: opening, error: openingErr } = await supabase
    .from('box_openings')
    .select('id, box_cost, box_name, status')
    .eq('id', boxOpeningId)
    .is('deleted_at', null)
    .single()
  if (openingErr || !opening) throw openingErr ?? new Error('Box opening not found')
  if (opening.status !== 'open') throw new Error('This breakdown is already closed')

  const { data: existingLots, error: lotsErr } = await supabase
    .from('inventory_lots')
    .select('unit_cost')
    .eq('box_opening_id', boxOpeningId)
    .is('deleted_at', null)
  if (lotsErr) throw lotsErr
  const allocated = (existingLots ?? []).reduce((sum, l) => sum + l.unit_cost, 0)
  const remaining = Math.max(0, Number(((opening.box_cost ?? 0) - allocated).toFixed(2)))

  if (remaining > 0.005) {
    const today = new Date().toISOString().slice(0, 10)
    const { error: txErr } = await supabase
      .from('transactions')
      .insert({
        user_id,
        date: today,
        amount: -remaining,
        schedule_c_category: 'cost_of_goods',
        source: 'manual',
        record_type: 'transaction',
        is_non_cash: false,
        notes: `Box close-out: ${opening.box_name} — bulk write-off`,
      })
    if (txErr) throw txErr
  }

  const { error: closeErr } = await supabase
    .from('box_openings')
    .update({ status: 'closed' })
    .eq('id', boxOpeningId)
  if (closeErr) throw closeErr

  return { remainingAmount: remaining }
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mutations.ts
git commit -m "feat: add startBoxOpening, addPullToOpening, closeBoxOpening mutations"
```

---

### Task 4: Update `useBoxOpening` to return `remainingBasis`

**Files:**
- Modify: `src/lib/queries.ts` (lines 170–218 — the `useBoxOpening` hook)

- [ ] **Step 1: Add `remainingBasis` to the return type and queryFn**

Replace the `useBoxOpening` function (lines 170–218) with:

```typescript
export function useBoxOpening(id: string | null) {
  return useQuery({
    queryKey: ['box-opening', id],
    enabled: !!id,
    queryFn: async (): Promise<{
      opening: BoxOpening
      cards: Array<{ id: string; quantity_remaining: number; quantity_purchased: number; unit_cost: number; items: { id: string; name: string } | null }>
      sourceLot: { id: string; quantity_remaining: number; unit_cost: number; items: { id: string; name: string } | null } | null
      transaction: Transaction | null
      remainingBasis: number
    }> => {
      const { data: opening, error } = await supabase
        .from('box_openings')
        .select('*')
        .eq('id', id!)
        .is('deleted_at', null)
        .single()
      if (error || !opening) throw error ?? new Error('Box opening not found')

      const [lotsRes, sourceLotRes, txRes] = await Promise.all([
        supabase
          .from('inventory_lots')
          .select('id, quantity_remaining, quantity_purchased, unit_cost, items(id, name)')
          .eq('box_opening_id', id!)
          .is('deleted_at', null)
          .order('unit_cost', { ascending: false }),
        opening.source_lot_id
          ? supabase
              .from('inventory_lots')
              .select('id, quantity_remaining, unit_cost, items(id, name)')
              .eq('id', opening.source_lot_id)
              .single()
          : Promise.resolve({ data: null, error: null }),
        opening.transaction_id
          ? supabase.from('transactions').select('*').eq('id', opening.transaction_id).single()
          : Promise.resolve({ data: null, error: null }),
      ])
      if (lotsRes.error) throw lotsRes.error
      if (sourceLotRes.error) throw sourceLotRes.error
      if (txRes.error) throw txRes.error

      const cards = (lotsRes.data ?? []) as unknown as Array<{ id: string; quantity_remaining: number; quantity_purchased: number; unit_cost: number; items: { id: string; name: string } | null }>
      const remainingBasis = Math.max(
        0,
        Number(((opening.box_cost ?? 0) - cards.reduce((s, c) => s + c.unit_cost, 0)).toFixed(2)),
      )

      return {
        opening: opening as BoxOpening,
        cards,
        sourceLot: (sourceLotRes.data ?? null) as unknown as { id: string; quantity_remaining: number; unit_cost: number; items: { id: string; name: string } | null } | null,
        transaction: (txRes.data ?? null) as Transaction | null,
        remainingBasis,
      }
    },
  })
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/queries.ts
git commit -m "feat: return remainingBasis from useBoxOpening"
```

---

### Task 5: Create `AddPullModal`

**Files:**
- Create: `src/components/modals/AddPullModal.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls } from '../Modal'
import ItemPicker from '../ItemPicker'
import { addPullToOpening } from '../../lib/mutations'
import { formatUSD } from '../../lib/utils'

interface Props {
  open: boolean
  onClose: () => void
  boxOpeningId: string
  remainingBasis: number
  onPullAdded: (lotId: string) => void
}

export default function AddPullModal({ open, onClose, boxOpeningId, remainingBasis, onPullAdded }: Props) {
  const qc = useQueryClient()
  const [itemId, setItemId] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [newItemName, setNewItemName] = useState('')
  const [basis, setBasis] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      addPullToOpening({
        boxOpeningId,
        itemId: isNew ? null : itemId,
        newItemName: isNew ? newItemName : null,
        basis: parseFloat(basis),
      }),
    onSuccess: ({ lotId }) => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['box-opening'] })
      onPullAdded(lotId)
      handleClose()
    },
  })

  function handleClose() {
    setItemId(null)
    setIsNew(false)
    setNewItemName('')
    setBasis('')
    mutation.reset()
    onClose()
  }

  const basisNum = parseFloat(basis)
  const hasItem = isNew ? newItemName.trim().length > 0 : !!itemId
  const valid = hasItem && !isNaN(basisNum) && basisNum > 0 && basisNum <= remainingBasis + 0.005

  return (
    <Modal open={open} onClose={handleClose} title="Add Pull">
      <div className="space-y-4 p-4">
        <Field label="Item">
          {isNew ? (
            <div className="space-y-2">
              <input
                autoFocus
                className={inputCls}
                placeholder="Card name"
                value={newItemName}
                onChange={e => setNewItemName(e.target.value)}
              />
              <button
                type="button"
                className="text-xs text-blue-600 hover:underline"
                onClick={() => { setIsNew(false); setNewItemName('') }}
              >
                ← Pick existing item
              </button>
            </div>
          ) : (
            <ItemPicker
              selectedId={itemId}
              onSelect={item => setItemId(item.id)}
              onCreateNew={() => setIsNew(true)}
            />
          )}
        </Field>

        <Field
          label="Basis"
          hint={`${formatUSD(remainingBasis)} remaining in pool`}
        >
          <div className="relative">
            <span className="absolute left-3 top-2 text-sm text-gray-500">$</span>
            <input
              className={`${inputCls} pl-6`}
              type="number"
              min="0.01"
              step="0.01"
              max={remainingBasis}
              placeholder="0.00"
              value={basis}
              onChange={e => setBasis(e.target.value)}
            />
          </div>
        </Field>

        {mutation.isError && (
          <p className="text-xs text-red-600">{(mutation.error as Error).message}</p>
        )}

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-40"
            onClick={() => mutation.mutate()}
            disabled={!valid || mutation.isPending}
          >
            {mutation.isPending ? 'Adding…' : 'Add Pull'}
          </button>
          <button
            type="button"
            className="flex-1 border border-gray-200 rounded-lg py-2 text-sm text-gray-700 hover:bg-gray-50"
            onClick={handleClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```
Expected: no errors. If `ItemPicker`'s `onCreateNew` prop doesn't exist, check `src/components/ItemPicker.tsx` for the correct prop name and adjust.

- [ ] **Step 3: Commit**

```bash
git add src/components/modals/AddPullModal.tsx
git commit -m "feat: add AddPullModal for lazy box breakdown pulls"
```

---

### Task 6: Update `BoxOpeningDetailSlideOver` for open-state UI

**Files:**
- Modify: `src/components/BoxOpeningDetailSlideOver.tsx` (full replacement — 143 lines currently)

- [ ] **Step 1: Replace the entire file**

```tsx
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Package, TrendingDown } from 'lucide-react'
import SlideOver from './SlideOver'
import ConfirmDialog from './ConfirmDialog'
import AddPullModal from './modals/AddPullModal'
import { useBoxOpening } from '../lib/queries'
import { deleteBoxOpening, closeBoxOpening } from '../lib/mutations'
import { formatUSD, formatDate } from '../lib/utils'

const METHOD_LABELS: Record<string, string> = {
  relative_fmv: 'Relative value',
  equal: 'Equal split',
  specific_id: 'Specific $',
}

interface Props {
  boxOpeningId: string | null
  onClose: () => void
}

export default function BoxOpeningDetailSlideOver({ boxOpeningId, onClose }: Props) {
  const qc = useQueryClient()
  const { data, isLoading } = useBoxOpening(boxOpeningId)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [showAddPull, setShowAddPull] = useState(false)
  const [newLotId, setNewLotId] = useState<string | null>(null)

  const del = useMutation({
    mutationFn: () => deleteBoxOpening(boxOpeningId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['box-opening'] })
      setConfirmDelete(false)
      onClose()
    },
    onError: () => setConfirmDelete(false),
  })

  const close = useMutation({
    mutationFn: () => closeBoxOpening(boxOpeningId!),
    onSuccess: ({ remainingAmount }) => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['box-opening'] })
      setConfirmClose(false)
      if (remainingAmount > 0.005) {
        // Toast shown via the ConfirmDialog success path — data refetch will
        // show the updated closed state automatically.
      }
    },
    onError: () => setConfirmClose(false),
  })

  if (!boxOpeningId) return null

  const isOpen = data?.opening.status === 'open'
  const remainingBasis = data?.remainingBasis ?? 0

  return (
    <>
      <SlideOver open={!!boxOpeningId} onClose={onClose} title="Breakdown" width="w-[480px]">
        {isLoading || !data ? (
          <div className="text-xs text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-4">
            {/* Header */}
            <div>
              <div className="text-lg font-semibold text-gray-900">{data.opening.box_name}</div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span className="text-sm text-gray-600">{formatDate(data.opening.opened_at)}</span>
                {isOpen && (
                  <>
                    <span className="text-gray-300 text-sm">·</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
                      In Progress
                    </span>
                  </>
                )}
                <span className="text-gray-300 text-sm">·</span>
                {data.opening.allocation_method && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700">
                    {METHOD_LABELS[data.opening.allocation_method] ?? data.opening.allocation_method}
                  </span>
                )}
                {!data.opening.allocation_method && !isOpen && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700">
                    Lazy (per-card)
                  </span>
                )}
              </div>
            </div>

            {/* Cost + pool balance */}
            <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Cost</div>
              <div className="text-base font-semibold text-gray-900 tabular-nums">
                {data.opening.box_cost !== null ? formatUSD(data.opening.box_cost) : '—'}
              </div>
              {data.sourceLot && (
                <div className="text-xs text-gray-500 mt-1">
                  {data.opening.quantity} × {formatUSD(data.sourceLot.unit_cost)} from{' '}
                  <span className="text-gray-700">{data.sourceLot.items?.name ?? '—'}</span>
                  {' '}({data.sourceLot.quantity_remaining} still in stock)
                </div>
              )}
              {isOpen && data.opening.box_cost !== null && (
                <div className="mt-2 pt-2 border-t border-gray-200 text-xs text-gray-600 tabular-nums">
                  Pool remaining:{' '}
                  <span className={remainingBasis < 0.01 ? 'text-green-600 font-medium' : 'font-medium text-gray-900'}>
                    {formatUSD(remainingBasis)}
                  </span>
                  {' '}of {formatUSD(data.opening.box_cost)}
                </div>
              )}
            </div>

            {/* Cards list */}
            <div>
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                Cards ({data.cards.length})
              </div>
              <div className="space-y-0.5">
                {data.cards.map(c => (
                  <div key={c.id} className="text-xs text-gray-700 flex justify-between items-center gap-2 py-1 border-b border-gray-50 last:border-0">
                    <span className="flex items-center gap-1.5 truncate">
                      <Package size={11} className="text-gray-400 shrink-0" />
                      <span className="truncate">{c.items?.name ?? '—'}</span>
                      {c.quantity_remaining === 0 && (
                        <span className="text-[10px] text-gray-400 shrink-0">sold</span>
                      )}
                      {c.id === newLotId && c.quantity_remaining > 0 && (
                        <span className="text-[10px] text-blue-500 shrink-0">← just added</span>
                      )}
                    </span>
                    <span className="tabular-nums text-gray-500 shrink-0">{formatUSD(c.unit_cost)}</span>
                  </div>
                ))}
                {data.cards.length === 0 && (
                  <div className="text-xs text-gray-400 italic">No pulls yet — add one below.</div>
                )}
              </div>
            </div>

            {/* Transaction panel */}
            {data.transaction && (
              <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Already deducted at purchase — no new Schedule C entry
                </div>
                <div className="flex justify-between items-center text-xs">
                  <div className="flex items-center gap-1.5 text-gray-700">
                    <TrendingDown size={12} className="text-gray-400 shrink-0" />
                    <span>Cost of Goods · {formatDate(data.transaction.date)}</span>
                  </div>
                  <span className="tabular-nums text-gray-500">
                    −{formatUSD(Math.abs(data.transaction.amount))}
                  </span>
                </div>
              </div>
            )}

            {/* Notes */}
            {data.opening.notes && (
              <div>
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Notes</div>
                <div className="text-xs text-gray-700">{data.opening.notes}</div>
              </div>
            )}

            {/* Footer actions */}
            <div className="mt-6 pt-4 border-t border-gray-200 space-y-2">
              {(del.isError || close.isError) && (
                <div className="text-xs text-red-600">
                  {((del.error ?? close.error) as Error).message}
                </div>
              )}

              {isOpen && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddPull(true)}
                    className="flex-1 px-3 py-2 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Add Pull
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClose(true)}
                    disabled={close.isPending}
                    className="flex-1 px-3 py-2 text-xs font-medium border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors disabled:opacity-50"
                  >
                    Close Box
                  </button>
                </div>
              )}

              {!isOpen && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    Delete breakdown
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </SlideOver>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete breakdown?"
        message="Removes the resulting card lots and restores the broken-down quantity back onto the source lot. Blocked if any card has already been sold — delete those sales first."
        confirmLabel="Delete breakdown"
        loading={del.isPending}
        onCancel={() => { setConfirmDelete(false); del.reset() }}
        onConfirm={() => del.mutate()}
      />

      <ConfirmDialog
        open={confirmClose}
        title="Close this box?"
        message={
          remainingBasis > 0.005
            ? `Write off ${formatUSD(remainingBasis)} to COGS and close this box. This records the remaining basis as a bulk disposal on Schedule C.`
            : 'All basis has been allocated to pulls. Close this box?'
        }
        confirmLabel="Close box"
        loading={close.isPending}
        onCancel={() => { setConfirmClose(false); close.reset() }}
        onConfirm={() => close.mutate()}
      />

      {data && (
        <AddPullModal
          open={showAddPull}
          onClose={() => setShowAddPull(false)}
          boxOpeningId={boxOpeningId!}
          remainingBasis={data.remainingBasis}
          onPullAdded={lotId => setNewLotId(lotId)}
        />
      )}
    </>
  )
}
```

Note: `formatUSD` is already imported from `'../lib/utils'`. The `ConfirmDialog` `message` prop — check if it accepts `string | ReactNode`; if it only accepts `string`, replace the ternary with a plain string.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/BoxOpeningDetailSlideOver.tsx
git commit -m "feat: add open-state UI to BoxOpeningDetailSlideOver (pool balance, add pull, close box)"
```

---

### Task 7: Update `OpenBoxModal` — add "Start — Add As I Pull" path

**Files:**
- Modify: `src/components/modals/OpenBoxModal.tsx`

Two changes: (1) add `onStarted` prop + `startLazy` mutation, (2) replace the `ModalActions` line with a three-button footer.

- [ ] **Step 1: Add `onStarted` to the Props interface and imports**

At the top of the file, the current import for mutations is:
```typescript
import { openBox, todayStr } from '../../lib/mutations'
```

Replace with:
```typescript
import { openBox, startBoxOpening, todayStr } from '../../lib/mutations'
```

Find the `interface Props` (or the function signature if there's no separate interface). The current signature is:
```typescript
export default function OpenBoxModal({ open, onClose }: { open: boolean; onClose: () => void }) {
```

Add `onStarted`:
```typescript
export default function OpenBoxModal({
  open,
  onClose,
  onStarted,
}: {
  open: boolean
  onClose: () => void
  onStarted?: (boxOpeningId: string) => void
}) {
```

- [ ] **Step 2: Add `startLazy` mutation inside the component**

Find the existing `const m = useMutation(...)` (around line 91). Add `startLazy` directly after it:

```typescript
  const startLazy = useMutation({
    mutationFn: () =>
      startBoxOpening({
        sourceLotId: sourceLotId!,
        openedAt,
        notes: notes.trim() || null,
      }),
    onSuccess: ({ boxOpeningId }) => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['box-opening'] })
      onStarted?.(boxOpeningId)
      reset()
      onClose()
    },
  })
```

- [ ] **Step 3: Replace `ModalActions` with a three-button footer**

Find line 333:
```typescript
        <ModalActions onCancel={handleClose} submitLabel="Break down" loading={m.isPending} disabled={!!validationError} />
```

Replace with:
```typescript
        {startLazy.isError && (
          <div className="mt-2 text-xs text-red-600">{(startLazy.error as Error).message}</div>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => startLazy.mutate()}
            disabled={!sourceLotId || !openedAt || startLazy.isPending || m.isPending}
            className="flex-1 px-3 py-2 text-sm border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 disabled:opacity-40"
          >
            {startLazy.isPending ? 'Starting…' : 'Start — Add As I Pull'}
          </button>
          <button
            type="submit"
            disabled={!!validationError || m.isPending || startLazy.isPending}
            className="flex-1 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40"
          >
            {m.isPending ? 'Breaking down…' : 'Break down'}
          </button>
        </div>
```

Also add `startLazy.reset()` to the existing `reset()` function:
```typescript
  function reset() {
    setSourceItemId(null); setSourceLotId(null); setQuantity(1); setOpenedAt(todayStr()); setNotes('')
    setMethod('relative_fmv'); setCards([emptyCard(), emptyCard()]); setPickerOpenIdx(null)
    m.reset()
    startLazy.reset()   // ← add this line
  }
```

- [ ] **Step 4: Wire `onStarted` in the parent (`InventoryPage.tsx`)**

Find where `OpenBoxModal` is rendered in `src/pages/InventoryPage.tsx`. It will look something like:
```tsx
<OpenBoxModal open={showOpenBox} onClose={() => setShowOpenBox(false)} />
```

The page already has a `selectedBoxOpeningId` state (or equivalent) driving `BoxOpeningDetailSlideOver`. Pass `onStarted` to open the detail slide-over immediately after starting:
```tsx
<OpenBoxModal
  open={showOpenBox}
  onClose={() => setShowOpenBox(false)}
  onStarted={id => {
    setShowOpenBox(false)
    setSelectedBoxOpeningId(id)   // use whatever state variable drives BoxOpeningDetailSlideOver
  }}
/>
```

> Check the exact state variable name in `InventoryPage.tsx` — search for `BoxOpeningDetailSlideOver` usage to find it.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/modals/OpenBoxModal.tsx src/pages/InventoryPage.tsx
git commit -m "feat: add 'Start — Add As I Pull' lazy breakdown path to OpenBoxModal"
```

---

### Task 8: Update docs

**Files:**
- Modify: `docs/features/inventory.md`

- [ ] **Step 1: Add lazy breakdown section**

Read the current file first. Find the existing `## Opening a Box` section. Add a new `### Lazy Breakdown` subsection directly after the existing description of the all-at-once flow:

```markdown
### Lazy Breakdown

An alternative to the all-at-once flow for box opens where pull counts aren't known upfront.

**Entry point:** "Breakdown Inventory" → "Start — Add As I Pull" — picks the source lot and date only; no cards required.

**Flow:**
1. "Start — Add As I Pull" creates an *open* breakdown (status `'open'`) and depletes the source lot.
2. `BoxOpeningDetailSlideOver` shows an "In Progress" badge and pool balance: `remaining = box_cost − Σ(child lot unit_costs)`.
3. "Add Pull" adds one card lot at a time. Each pull specifies an item and a basis amount drawn from the pool.
4. "Close Box" finalizes: if any pool balance remains, inserts a `transactions` row (`cost_of_goods`, negative amount) as a bulk write-off, then marks the breakdown `'closed'`.

**Accounting:** Under §471(c) NIMS, each card's cost hits COGS at time of sale (FIFO depletion of its lot). The close-out write-off is a bulk disposal event — correct when remaining cards are genuinely discarded. The pool balance display shows how much basis is unallocated at any point.

**Schema note:** `box_openings.status` added in migration `20260928120000_lazy_box_breakdown.sql`. All pre-existing breakdowns are `'closed'`; all-at-once `openBox()` also sets `'closed'` explicitly.
```

- [ ] **Step 2: Commit**

```bash
git add docs/features/inventory.md
git commit -m "docs: add lazy box breakdown section to inventory feature doc"
```

---

## Manual Verification Checklist

After all tasks are complete, verify end-to-end in the running dev server (`npm run dev`):

- [ ] Existing all-at-once breakdown still works (no regression): create a breakdown with cards → confirm status = `'closed'` in Supabase, no "In Progress" badge in slide-over
- [ ] Lazy start: "Breakdown Inventory" → pick item/lot → "Start — Add As I Pull" → slide-over opens with "In Progress" badge and pool balance showing full box cost
- [ ] Add pull: "Add Pull" → pick item, enter basis → pool balance decrements correctly
- [ ] Add pull over remaining: entering a basis > remaining shows an error, doesn't submit
- [ ] Close box with remaining: "Close Box" → confirm → write-off transaction appears in Expenses with `cost_of_goods` category and correct amount
- [ ] Close box at $0 remaining: "Close Box" → no transaction created → breakdown closed silently
- [ ] Delete button hidden while open: the "Delete breakdown" button is not shown while status = `'open'`; appears after close

---

## Known Limitations (v1)

- **"Record Sale →" shortcut not implemented:** The spec describes an inline "Record Sale →" button after adding a pull. `RecordSaleModal` currently accepts only `{ open, onClose }` with no pre-population prop, making the shortcut low-value (user would still need to find the item manually). Adding `initialItemId` to `RecordSaleModal` is a follow-up improvement, not implemented here.
- **`AddPullModal` item category:** When creating a new item inline, there is no category picker in v1 (category defaults to `null`). The item can be edited from Inventory later.
