# Settings Page + Plaid Link for Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the web client's first Settings page with a Bank Connections section wired to Plaid Link (create / sync / force-resync / reconnect / disconnect / per-account toggles) and an inline Custom Categories section that reuses the already-shipped management UI.

**Architecture:** Single `/settings` route owning a `usePlaidLink` instance (Approach A from the spec). Data goes through React Query hooks in `queries.ts`; writes go through bare async functions in `mutations.ts` (matching the existing codebase pattern — components wrap them with `useMutation` inline). A small migration adds `status` + `error_message` columns to `plaid_items` so the "Reconnect needed" badge survives reloads; the client degrades gracefully if the columns are missing. The existing `ManageCategoriesModal` body is extracted into a reusable `CustomCategoriesList` so both the modal (still used from in-context dropdowns) and the Settings section render identical UI.

**Tech Stack:** React 19, TypeScript, React Router v7, TanStack React Query, Tailwind v4, Supabase JS, lucide-react icons, `react-plaid-link` (new dependency).

**Spec:** [docs/superpowers/specs/2026-06-25-settings-and-plaid-design.md](../specs/2026-06-25-settings-and-plaid-design.md)

---

## File map

```
src/App.tsx                                       # add /settings route
src/components/Layout.tsx                         # add Settings to NAV
src/components/CustomCategoriesList.tsx           # NEW — extracted body of ManageCategoriesModal
src/components/modals/ManageCategoriesModal.tsx   # slim down to <Modal><CustomCategoriesList onClose /></Modal>
src/pages/SettingsPage.tsx                        # NEW — owns usePlaidLink + page shell
src/pages/settings/BankConnectionsSection.tsx     # NEW — section header + list
src/pages/settings/BankItemCard.tsx               # NEW — one connected institution
src/pages/settings/AccountRow.tsx                 # NEW — display_name + sync toggle
src/pages/settings/itemStatus.ts                  # NEW — getItemStatus helper + tiny unit spec
src/pages/settings/__tests__/itemStatus.test.ts   # NEW — vitest spec for the helper
src/lib/queries.ts                                # add usePlaidItems, usePlaidAccounts
src/lib/mutations.ts                              # add Plaid mutations + updatePlaidAccount
src/lib/types.ts                                  # add PlaidItem, PlaidAccount
package.json                                      # add react-plaid-link
.env.example                                      # document VITE_PLAID_ENV (create if missing)
docs/features/settings.md                         # NEW page doc (per CLAUDE.md rule)
docs/supabase-schema.md                           # document new plaid_items columns
supabase/migrations/<ts>_plaid_item_status.sql    # NEW migration (or applied via MCP)
```

Tests live under `src/pages/settings/__tests__/` to colocate with the page they cover (matching `src/lib/__tests__/` precedent).

---

## Task 1: Install `react-plaid-link` and add types/env config

**Files:**
- Modify: `package.json`
- Create: `.env.example` (if missing — check first)
- Modify: `src/lib/types.ts` (append)

- [ ] **Step 1: Install dependency**

```bash
npm install react-plaid-link
```

Expected: a `react-plaid-link` entry appears in `package.json` `dependencies`. Currently the project has no Plaid wiring; no transitive conflicts expected.

- [ ] **Step 2: Add PlaidItem / PlaidAccount types**

Append to `src/lib/types.ts`:

```ts
export interface PlaidItem {
  id: string
  user_id: string | null
  item_id: string
  access_token: string
  institution_name: string | null
  institution_id: string | null
  last_synced_at: string | null
  cursor: string | null
  transactions_cursor: string | null
  created_at: string | null
  /** Added by the plaid_item_status migration. Treat absent column as 'active'. */
  status?: 'active' | 'login_required' | 'error'
  error_message?: string | null
}

export interface PlaidAccount {
  id: string
  user_id: string | null
  item_id: string
  account_id: string
  name: string | null
  mask: string | null
  subtype: string | null
  display_name: string | null
  sync_enabled: boolean
  created_at: string | null
}
```

- [ ] **Step 3: Add `.env.example` entry**

If `.env.example` doesn't exist, create it with the existing Vite env vars used by `src/lib/supabase.ts` plus the new one:

```bash
# .env.example
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
# Cosmetic footer label on Settings. Real Plaid env is owned server-side.
VITE_PLAID_ENV=sandbox
```

If `.env.example` already exists, just append the `VITE_PLAID_ENV` line.

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: PASS. Types compile cleanly.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example src/lib/types.ts
git commit -m "feat(settings): add react-plaid-link + Plaid types"
```

---

## Task 2: Apply `plaid_items` status migration

This is optional but unlocks the "Reconnect needed" badge. The client treats absent columns as `'active'`.

**Files:**
- Create: `supabase/migrations/<timestamp>_plaid_item_status.sql` OR apply via MCP `apply_migration`.

- [ ] **Step 1: Write the migration**

If `supabase/migrations/` exists in the repo, create the file. Otherwise use the Supabase MCP tool `apply_migration` with this name + SQL:

Name: `plaid_item_status`

```sql
alter table public.plaid_items
  add column status text not null default 'active'
    check (status in ('active', 'login_required', 'error')),
  add column error_message text;

comment on column public.plaid_items.status is
  'Connection health: active = normal, login_required = needs Plaid Link update mode, error = generic failure.';
```

- [ ] **Step 2: Apply the migration**

Via MCP: invoke `mcp__supabase__apply_migration` with the above name and query.

Via CLI (if `supabase` is linked locally): `supabase db push`.

Expected: no error. Existing 3 `plaid_items` rows default to `status = 'active'`.

- [ ] **Step 3: Verify**

```bash
# via the Supabase MCP execute_sql:
select id, institution_name, status, error_message from plaid_items;
```

Expected: 3 rows, all `status = 'active'`, `error_message = null`.

- [ ] **Step 4: Document in schema doc**

In `docs/supabase-schema.md`, locate the section that describes `plaid_items` (or the general "Plaid" area near line 120). Add a row noting the two new columns:

```markdown
| `status` (`'active' \| 'login_required' \| 'error'`) | Health of the Plaid connection. Defaults to `'active'`. Written by `plaid_sync_transactions` on `ITEM_LOGIN_REQUIRED` and reset by `plaid_exchange_token` on update-mode success. Web client reads this to drive the "Reconnect needed" badge in Settings; treats the column as `'active'` if missing. |
| `error_message` | Optional human-readable Plaid error string, shown as a tooltip on the status badge. |
```

- [ ] **Step 5: Commit**

```bash
git add docs/supabase-schema.md supabase/migrations/  # supabase/ may not exist; omit if so
git commit -m "feat(settings): add plaid_items.status + error_message columns"
```

---

## Task 3: Add `usePlaidItems` and `usePlaidAccounts` query hooks

**Files:**
- Modify: `src/lib/queries.ts` (append)

- [ ] **Step 1: Add `usePlaidItems`**

Append to `src/lib/queries.ts`:

```ts
import type { PlaidItem, PlaidAccount } from './types'

/** Lists the user's connected Plaid institutions. RLS scopes by user_id. */
export function usePlaidItems() {
  return useQuery({
    queryKey: ['plaid_items'],
    queryFn: async (): Promise<PlaidItem[]> => {
      const { data, error } = await supabase
        .from('plaid_items')
        .select('id, user_id, item_id, access_token, institution_name, institution_id, last_synced_at, cursor, transactions_cursor, created_at, status, error_message')
        .order('institution_name', { ascending: true, nullsFirst: false })
      if (error) throw error
      return (data ?? []) as PlaidItem[]
    },
  })
}

/**
 * Lists Plaid accounts under one institution.
 *
 * `itemId` here is the Plaid-side string id (the `item_id` column on plaid_items and
 * plaid_accounts), NOT the DB row uuid. Pass `plaidItem.item_id`, not `plaidItem.id`.
 */
export function usePlaidAccounts(itemId: string | null) {
  return useQuery({
    queryKey: ['plaid_accounts', itemId],
    enabled: !!itemId,
    queryFn: async (): Promise<PlaidAccount[]> => {
      const { data, error } = await supabase
        .from('plaid_accounts')
        .select('id, user_id, item_id, account_id, name, mask, subtype, display_name, sync_enabled, created_at')
        .eq('item_id', itemId!)
        .order('name', { ascending: true, nullsFirst: false })
      if (error) throw error
      return (data ?? []) as PlaidAccount[]
    },
  })
}
```

If the `status` / `error_message` columns don't exist yet (migration not applied), the select will fail. To make this forward-compat, swap the select to a star or guard the columns:

```ts
.select('*')
```

The `PlaidItem` interface marks `status` / `error_message` optional, so star-select is fine.

Use `.select('*')` for now — simpler and graceful.

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/queries.ts
git commit -m "feat(settings): add usePlaidItems and usePlaidAccounts query hooks"
```

---

## Task 4: Add Plaid edge-function wrappers + account update in `mutations.ts`

**Files:**
- Modify: `src/lib/mutations.ts` (append)

- [ ] **Step 1: Add the five mutation functions**

Append to `src/lib/mutations.ts`:

```ts
// ────────────────────────────────────────────────────────────
// Plaid
// ────────────────────────────────────────────────────────────

export interface PlaidCreateLinkTokenResult {
  link_token: string
  expiration?: string
}

/**
 * Calls plaid_create_link_token. Pass an item_id to request an update-mode token
 * (used when a connection has status='login_required' and needs re-auth).
 */
export async function plaidCreateLinkToken(itemId?: string): Promise<PlaidCreateLinkTokenResult> {
  const body = itemId ? { item_id: itemId } : {}
  const { data, error } = await supabase.functions.invoke('plaid_create_link_token', { body })
  if (error) throw error
  return data as PlaidCreateLinkTokenResult
}

/**
 * Exchanges a Plaid Link public_token for an access_token and persists a plaid_items row
 * (or refreshes the existing one for update mode). Backend reads institution from metadata.
 */
export async function plaidExchangeToken(params: {
  public_token: string
  metadata: unknown
}): Promise<void> {
  const { error } = await supabase.functions.invoke('plaid_exchange_token', {
    body: params,
  })
  if (error) throw error
}

export interface PlaidSyncResult {
  /** Server returns the number of newly-inserted transactions (may be undefined on legacy responses). */
  inserted?: number
}

/**
 * Triggers an incremental Plaid sync. When `reset_cursor=true`, the backend must clear the
 * stored cursor first and re-pull full history. If the backend ignores the flag, Force Full
 * Resync silently degrades to a normal Sync Now — documented in the spec.
 */
export async function plaidSyncTransactions(params: {
  item_id: string
  reset_cursor?: boolean
}): Promise<PlaidSyncResult> {
  const { data, error } = await supabase.functions.invoke('plaid_sync_transactions', {
    body: params,
  })
  if (error) throw error
  return (data ?? {}) as PlaidSyncResult
}

/** Disconnects an institution. Backend removes plaid_items + cascades plaid_accounts. */
export async function plaidRemoveItem(itemId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('plaid_remove_item', {
    body: { item_id: itemId },
  })
  if (error) throw error
}

/** Direct table update — RLS scopes by user_id. */
export async function updatePlaidAccount(
  id: string,
  patch: { display_name?: string | null; sync_enabled?: boolean }
): Promise<void> {
  const { error } = await supabase.from('plaid_accounts').update(patch).eq('id', id)
  if (error) throw error
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mutations.ts
git commit -m "feat(settings): add Plaid mutation wrappers"
```

---

## Task 5: Write + verify the `getItemStatus` helper (with unit test)

This is the one piece of testable logic in the whole feature. TDD it.

**Files:**
- Create: `src/pages/settings/itemStatus.ts`
- Create: `src/pages/settings/__tests__/itemStatus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/pages/settings/__tests__/itemStatus.test.ts
import { describe, it, expect } from 'vitest'
import type { PlaidItem } from '../../../lib/types'
import { getItemStatus } from '../itemStatus'

function item(over: Partial<PlaidItem> = {}): PlaidItem {
  return {
    id: 'x',
    user_id: 'u',
    item_id: 'plaid-x',
    access_token: 'a',
    institution_name: 'Test Bank',
    institution_id: null,
    last_synced_at: null,
    cursor: null,
    transactions_cursor: null,
    created_at: null,
    ...over,
  }
}

describe('getItemStatus', () => {
  it('returns "syncing" when the mutation is in flight, regardless of persisted status', () => {
    expect(getItemStatus(item({ status: 'login_required' }), true)).toBe('syncing')
  })

  it('returns "reconnect" when status is login_required and not syncing', () => {
    expect(getItemStatus(item({ status: 'login_required' }), false)).toBe('reconnect')
  })

  it('returns "error" when status is error', () => {
    expect(getItemStatus(item({ status: 'error' }), false)).toBe('error')
  })

  it('returns "connected" when status is active', () => {
    expect(getItemStatus(item({ status: 'active' }), false)).toBe('connected')
  })

  it('treats absent status (pre-migration) as connected', () => {
    expect(getItemStatus(item(), false)).toBe('connected')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/pages/settings/__tests__/itemStatus.test.ts
```

Expected: FAIL — `Cannot find module '../itemStatus'`.

- [ ] **Step 3: Implement the helper**

```ts
// src/pages/settings/itemStatus.ts
import type { PlaidItem } from '../../lib/types'

export type ItemStatusBadge = 'connected' | 'syncing' | 'reconnect' | 'error'

export function getItemStatus(item: PlaidItem, isSyncing: boolean): ItemStatusBadge {
  if (isSyncing) return 'syncing'
  switch (item.status) {
    case 'login_required':
      return 'reconnect'
    case 'error':
      return 'error'
    case 'active':
    default:
      return 'connected'
  }
}
```

- [ ] **Step 4: Run the test, watch it pass**

```bash
npx vitest run src/pages/settings/__tests__/itemStatus.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/pages/settings/itemStatus.ts src/pages/settings/__tests__/itemStatus.test.ts
git commit -m "feat(settings): add getItemStatus helper with unit tests"
```

---

## Task 6: Extract `CustomCategoriesList` from `ManageCategoriesModal`

Move the modal body (everything inside `<div className="space-y-4">`, plus the `CategoryRow` / `CategoryForm` / `HelpContent` subcomponents) into a new file. The modal becomes a thin shell.

**Files:**
- Create: `src/components/CustomCategoriesList.tsx`
- Modify: `src/components/modals/ManageCategoriesModal.tsx`

- [ ] **Step 1: Create `CustomCategoriesList.tsx`**

Copy the entire current `ManageCategoriesModal.tsx` to `CustomCategoriesList.tsx`, then transform per below. Open `src/components/CustomCategoriesList.tsx` (new file) and write:

```tsx
import { useState, useMemo, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { Field, inputCls, ModalActions } from './Modal'
import ConfirmDialog from './ConfirmDialog'
import CategoryBadge from './CategoryBadge'
import InfoPopover from './InfoPopover'
import { CATEGORIES, describeScheduleLine, type CustomCategory } from '../lib/categories'
import { PALETTE, PALETTE_KEYS, type ColorKey } from '../lib/categoryPalette'
import { useCustomCategories } from '../lib/queries'
import {
  createCustomCategory,
  updateCustomCategory,
  deleteCustomCategory,
  countTransactionsUsingCustomCategory,
} from '../lib/mutations'

type Mode = 'list' | 'create' | { mode: 'edit'; id: string }
type Mapping = 'parent' | 'line'

const SCHEDULE_LINES: string[] = (() => {
  const lines = new Set<string>(['Part I', 'Part III'])
  for (const c of CATEGORIES) {
    if (c.scheduleLine?.startsWith('Line ') && c.scheduleLine !== 'Line 24b') {
      lines.add(c.scheduleLine)
    }
  }
  return Array.from(lines)
})()

/**
 * The category management UI body. Used in two places:
 *   - ManageCategoriesModal: passes `onClose` so the "Done" button dismisses the modal.
 *   - SettingsPage Custom Categories section: omits `onClose` to hide the "Done" button.
 */
export default function CustomCategoriesList({ onClose }: { onClose?: () => void }) {
  const { data: customs = [] } = useCustomCategories()
  const [mode, setMode] = useState<Mode>('list')

  const active = useMemo(() => customs.filter(c => !c.deletedAt), [customs])
  const editing = useMemo(() => {
    if (typeof mode === 'object' && mode.mode === 'edit') {
      return active.find(c => c.id === mode.id) ?? null
    }
    return null
  }, [mode, active])

  return (
    <div className="space-y-4">
      <div className="flex justify-end -mt-2 mb-2">
        <InfoPopover label="How custom categories work" width="w-[360px]">
          <HelpContent />
        </InfoPopover>
      </div>
      {mode === 'list' && (
        <>
          <button
            type="button"
            onClick={() => setMode('create')}
            className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
          >
            <Plus size={14} /> New category
          </button>

          {active.length === 0 ? (
            <p className="text-sm text-gray-500">
              No custom categories yet. Click <em>New category</em> to create one for things like
              "Stripe Fees" or a line item that isn't in the built-in list.
            </p>
          ) : (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                Your categories
              </div>
              <ul className="space-y-1">
                {active.map(c => (
                  <CategoryRow key={c.id} c={c} onEdit={() => setMode({ mode: 'edit', id: c.id })} />
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Built-in (read-only)
            </div>
            <ul className="space-y-1">
              {CATEGORIES.filter(c => !c.isExcluded).map(c => (
                <li key={c.value} className="flex items-center gap-2 text-xs text-gray-600 py-1">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                  <span>{c.label}</span>
                  {c.scheduleLine && <span className="ml-auto text-gray-400">{c.scheduleLine}</span>}
                </li>
              ))}
            </ul>
          </div>

          {onClose && <ModalActions onCancel={onClose} submitLabel="Done" />}
        </>
      )}

      {(mode === 'create' || editing) && (
        <CategoryForm
          initial={editing}
          onSaved={() => setMode('list')}
          onCancel={() => setMode('list')}
          onDeleted={() => setMode('list')}
        />
      )}
    </div>
  )
}

function CategoryRow({ c, onEdit }: { c: CustomCategory; onEdit: () => void }) {
  const parentLabel = c.parentValue
    ? CATEGORIES.find(b => b.value === c.parentValue)?.label
    : null
  return (
    <li className="flex items-start gap-3 py-1.5">
      <div className="flex-1 min-w-0">
        <CategoryBadge value={c.value} />
        <div className="text-xs text-gray-400 mt-0.5">
          {c.parentValue
            ? <>parent: {parentLabel ?? c.parentValue}</>
            : <>{c.scheduleLine}</>}
        </div>
      </div>
      <span className="text-xs text-gray-500 ml-auto self-center">
        {c.parentValue
          ? CATEGORIES.find(b => b.value === c.parentValue)?.scheduleLine
          : c.scheduleLine}
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
        aria-label="Edit"
      >
        <Pencil size={14} />
      </button>
    </li>
  )
}

function CategoryForm({
  initial,
  onSaved,
  onCancel,
  onDeleted,
}: {
  initial: CustomCategory | null
  onSaved: () => void
  onCancel: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(initial?.name ?? '')
  const [colorKey, setColorKey] = useState<ColorKey>(initial?.colorKey ?? 'emerald')
  const [mapping, setMapping] = useState<Mapping>(initial?.parentValue ? 'parent' : 'line')
  const [parentValue, setParentValue] = useState(initial?.parentValue ?? CATEGORIES.find(c => !c.isExcluded)!.value)
  const [scheduleLine, setScheduleLine] = useState(initial?.scheduleLine ?? 'Line 27a')
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const showPartIIIWarning = mapping === 'line' && scheduleLine === 'Part III'

  const txCountQuery = useQuery({
    queryKey: ['custom_category_usage', initial?.id],
    enabled: !!initial && confirmDelete,
    queryFn: () => countTransactionsUsingCustomCategory(initial!.id),
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name,
        colorKey,
        parentValue: mapping === 'parent' ? parentValue : null,
        scheduleLine: mapping === 'line' ? scheduleLine : null,
      }
      if (initial) {
        await updateCustomCategory(initial.id, payload)
      } else {
        await createCustomCategory(payload)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom_categories'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onSaved()
    },
    onError: (e: Error) => setError(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteCustomCategory(initial!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom_categories'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onDeleted()
    },
    onError: (e: Error) => setError(e.message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    saveMutation.mutate()
  }

  const previewSwatch = PALETTE[colorKey]

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="text-sm font-semibold text-gray-900">
        {initial ? 'Edit category' : 'New category'}
      </div>

      <Field label="Name">
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={40}
          className={inputCls}
          placeholder="e.g. Stripe Fees"
        />
        <div className="text-xs text-gray-400 text-right mt-0.5">{name.length}/40</div>
      </Field>

      <Field label="Color">
        <div className="grid grid-cols-6 gap-2">
          {PALETTE_KEYS.map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setColorKey(k)}
              className={`h-8 rounded-lg border-2 transition-all ${
                colorKey === k ? 'border-gray-900 ring-2 ring-gray-300' : 'border-transparent'
              }`}
              style={{ backgroundColor: PALETTE[k].bgColor }}
              aria-label={k}
            >
              <span className="block w-3 h-3 rounded-full mx-auto" style={{ backgroundColor: PALETTE[k].color }} />
            </button>
          ))}
        </div>
      </Field>

      <Field label="Tax mapping">
        <div className="space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              checked={mapping === 'parent'}
              onChange={() => setMapping('parent')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm">Refine an existing category</div>
              {mapping === 'parent' && (
                <select
                  value={parentValue}
                  onChange={e => setParentValue(e.target.value)}
                  className={inputCls + ' bg-white mt-1'}
                >
                  {CATEGORIES.map(c => (
                    <option key={c.value} value={c.value}>
                      {c.label}{c.scheduleLine ? ` (${c.scheduleLine})` : ' (excluded)'}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </label>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              checked={mapping === 'line'}
              onChange={() => setMapping('line')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm">Map to a Schedule C line directly</div>
              {mapping === 'line' && (
                <>
                  <select
                    value={scheduleLine}
                    onChange={e => setScheduleLine(e.target.value)}
                    className={inputCls + ' bg-white mt-1'}
                  >
                    {SCHEDULE_LINES.map(l => (
                      <option key={l} value={l}>{describeScheduleLine(l)}</option>
                    ))}
                  </select>
                  {showPartIIIWarning && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-1">
                      Part III is for inventory cost — most users won't need a custom there. Continue if you're sure.
                    </div>
                  )}
                </>
              )}
            </div>
          </label>
        </div>
      </Field>

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1.5">Preview</div>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
          style={{ color: previewSwatch.color, backgroundColor: previewSwatch.bgColor }}
        >
          {name.trim() || 'Preview'}
        </span>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}

      <div className="flex items-center justify-between">
        {initial ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1 text-xs text-red-600 hover:text-red-800"
          >
            <Trash2 size={12} /> Delete
          </button>
        ) : <span />}
        <ModalActions
          onCancel={onCancel}
          submitLabel={initial ? 'Save changes' : 'Create category'}
          loading={saveMutation.isPending}
        />
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this category?"
        message={
          txCountQuery.isLoading
            ? 'Checking how many transactions reference it…'
            : (txCountQuery.data ?? 0) > 0
              ? `${txCountQuery.data} transaction${txCountQuery.data === 1 ? '' : 's'} use this category. They'll keep showing the tag with "(deleted)" until you recategorize them.`
              : 'This category isn\'t used by any transactions yet.'
        }
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </form>
  )
}

function HelpContent() {
  return (
    <div className="space-y-3 leading-relaxed">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Custom Schedule C categories</h3>
        <p>
          Add your own labels for transactions when the built-in list doesn't fit. Every custom
          category still rolls up to a real Schedule C line, so totals stay tax-correct.
        </p>
      </div>

      <div>
        <p>
          <strong>Refine an existing category</strong> — pick a built-in (e.g. <em>Commissions &amp;
          Fees</em>) and your custom acts as a sub-label of it. Inherits the line, the
          50% meals deduction if applicable, and the "non-business" flag for Transfer / Personal etc.
        </p>
        <p className="mt-1 text-gray-500">
          Use this when you want finer reporting under an existing bucket — e.g. "Stripe Fees"
          under Commissions &amp; Fees.
        </p>
      </div>

      <div>
        <p>
          <strong>Map to a Schedule C line directly</strong> — pick a line by its IRS form name
          (e.g. <em>Utilities (Line 25)</em>) and your custom becomes a fresh entry under it.
        </p>
        <p className="mt-1 text-gray-500">
          Use this when nothing in the built-in list is close enough — e.g. a recurring
          "Reseller Subscription" you want to track under Utilities.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">A few notes</h3>
        <ul className="list-disc pl-4 space-y-1">
          <li>
            Deleting a custom hides it from pickers but historical transactions keep showing
            the tag with "(deleted)" and still count toward the right Schedule C line.
          </li>
          <li>
            Line 24b (Meals, 50% deductible) isn't in the explicit-line picker — use
            <em> Refine an existing</em> with parent <em>Meals (50%)</em> so the half-deduction
            is inherited automatically.
          </li>
          <li>
            Names must be unique among your active categories. Up to 40 characters.
          </li>
        </ul>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Replace `ManageCategoriesModal.tsx` with a thin shell**

```tsx
// src/components/modals/ManageCategoriesModal.tsx
import Modal from '../Modal'
import CustomCategoriesList from '../CustomCategoriesList'

export default function ManageCategoriesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Manage categories">
      <CustomCategoriesList onClose={onClose} />
    </Modal>
  )
}
```

- [ ] **Step 3: Verify nothing else imports the removed sub-components**

```bash
grep -rn "CategoryRow\|CategoryForm\|HelpContent" src/ --include="*.tsx" --include="*.ts"
```

Expected: hits only inside `CustomCategoriesList.tsx`. If anything outside references them, the refactor broke an import.

- [ ] **Step 4: Verify build + lint**

```bash
npm run build && npm run lint
```

Expected: both PASS.

- [ ] **Step 5: Manual smoke test**

Run `npm run dev`. Open the app. From the Expenses page, open any transaction's category dropdown → click "Manage categories". The modal opens; create a category, edit it, delete it. Same behavior as before.

- [ ] **Step 6: Commit**

```bash
git add src/components/CustomCategoriesList.tsx src/components/modals/ManageCategoriesModal.tsx
git commit -m "refactor(categories): extract CustomCategoriesList from ManageCategoriesModal"
```

---

## Task 7: Add `/settings` route + Settings nav entry

**Files:**
- Modify: `src/components/Layout.tsx`
- Modify: `src/App.tsx`
- Create: `src/pages/SettingsPage.tsx` (placeholder for now — real content lands in Task 8+)

- [ ] **Step 1: Create the page placeholder**

```tsx
// src/pages/SettingsPage.tsx
export default function SettingsPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage bank connections and custom categories
        </p>
      </div>
      <div className="text-sm text-gray-400">Coming up next.</div>
    </div>
  )
}
```

- [ ] **Step 2: Add nav entry**

Modify `src/components/Layout.tsx` line 2 (the import line) and the `NAV` array:

```tsx
import { Outlet, NavLink } from 'react-router-dom'
import { LayoutDashboard, ShoppingCart, Package, Receipt, Settings, LogOut } from 'lucide-react'
import { supabase } from '../lib/supabase'

const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sales', icon: ShoppingCart, label: 'Sales' },
  { to: '/inventory', icon: Package, label: 'Inventory' },
  { to: '/expenses', icon: Receipt, label: 'Expenses' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]
```

(Add `Settings` to the lucide import; add the new entry at the end of `NAV`.)

- [ ] **Step 3: Register the route in `App.tsx`**

Add the import and route. In `src/App.tsx`, after the existing page imports add:

```tsx
import SettingsPage from './pages/SettingsPage'
```

Inside the authenticated `<Route element={<Layout />}>` block, add the new route between `/expenses` and the catch-all redirect:

```tsx
<Route path="/expenses" element={<ExpensesPage />} />
<Route path="/settings" element={<SettingsPage />} />
<Route path="*" element={<Navigate to="/dashboard" replace />} />
```

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

Open the app. Click the "Settings" sidebar entry. The placeholder page renders. URL becomes `/settings`. Direct nav to `http://localhost:5173/settings` also works.

- [ ] **Step 5: Verify build**

```bash
npm run build && npm run lint
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/Layout.tsx src/pages/SettingsPage.tsx
git commit -m "feat(settings): add /settings route and sidebar entry"
```

---

## Task 8: Build the `AccountRow` component (per-account UI)

**Files:**
- Create: `src/pages/settings/AccountRow.tsx`

- [ ] **Step 1: Write `AccountRow.tsx`**

```tsx
// src/pages/settings/AccountRow.tsx
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Check, X } from 'lucide-react'
import type { PlaidAccount } from '../../lib/types'
import { updatePlaidAccount } from '../../lib/mutations'

export default function AccountRow({ account }: { account: PlaidAccount }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(account.display_name ?? account.name ?? '')

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      updatePlaidAccount(account.id, { display_name: name.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaid_accounts', account.item_id] })
      setEditing(false)
    },
  })

  const syncToggleMutation = useMutation({
    mutationFn: (next: boolean) => updatePlaidAccount(account.id, { sync_enabled: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaid_accounts', account.item_id] })
    },
  })

  const displayName = account.display_name ?? account.name ?? '(unnamed account)'

  return (
    <li className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-gray-50">
      {editing ? (
        <>
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') renameMutation.mutate(draft)
              if (e.key === 'Escape') { setDraft(account.display_name ?? account.name ?? ''); setEditing(false) }
            }}
            className="flex-1 min-w-0 text-sm border border-gray-300 rounded px-2 py-1"
          />
          <button
            type="button"
            onClick={() => renameMutation.mutate(draft)}
            disabled={renameMutation.isPending}
            className="p-1 text-green-600 hover:text-green-700 disabled:opacity-40"
            aria-label="Save"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={() => { setDraft(account.display_name ?? account.name ?? ''); setEditing(false) }}
            className="p-1 text-gray-400 hover:text-gray-600"
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <>
          <span className="text-sm text-gray-900 min-w-0 truncate flex-1">
            {displayName}
            {account.mask && <span className="text-gray-400 ml-1">•• {account.mask}</span>}
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="p-1 text-gray-400 hover:text-gray-700"
            aria-label="Rename"
          >
            <Pencil size={12} />
          </button>
          {account.subtype && (
            <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded capitalize">
              {account.subtype}
            </span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={account.sync_enabled}
              disabled={syncToggleMutation.isPending}
              onChange={e => syncToggleMutation.mutate(e.target.checked)}
              className="h-4 w-4"
            />
            Sync
          </label>
        </>
      )}
      {renameMutation.isError && (
        <span className="text-xs text-red-600 ml-2">
          {(renameMutation.error as Error).message}
        </span>
      )}
    </li>
  )
}
```

- [ ] **Step 2: Verify build + lint**

```bash
npm run build && npm run lint
```

Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add src/pages/settings/AccountRow.tsx
git commit -m "feat(settings): AccountRow with inline rename + sync toggle"
```

---

## Task 9: Build the `BankItemCard` component (one institution)

This component renders the header row + action row + accounts list for one `plaid_item`. It accepts callbacks from the parent for actions that need to launch Plaid Link (which the parent owns).

**Files:**
- Create: `src/pages/settings/BankItemCard.tsx`

- [ ] **Step 1: Write `BankItemCard.tsx`**

```tsx
// src/pages/settings/BankItemCard.tsx
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MoreVertical, RefreshCw } from 'lucide-react'
import type { PlaidItem } from '../../lib/types'
import { usePlaidAccounts } from '../../lib/queries'
import { plaidSyncTransactions, plaidRemoveItem } from '../../lib/mutations'
import ConfirmDialog from '../../components/ConfirmDialog'
import AccountRow from './AccountRow'
import { getItemStatus, type ItemStatusBadge } from './itemStatus'

interface Props {
  item: PlaidItem
  /** Parent owns Plaid Link; calls back to launch update mode for this item. */
  onReconnect: () => void
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never synced'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `Synced ${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `Synced ${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `Synced ${days}d ago`
}

function StatusBadge({ status, message }: { status: ItemStatusBadge; message?: string | null }) {
  const styles: Record<ItemStatusBadge, string> = {
    connected: 'bg-green-50 text-green-700 border-green-200',
    syncing: 'bg-amber-50 text-amber-700 border-amber-200',
    reconnect: 'bg-red-50 text-red-700 border-red-200',
    error: 'bg-red-50 text-red-700 border-red-200',
  }
  const labels: Record<ItemStatusBadge, string> = {
    connected: 'Connected',
    syncing: 'Syncing…',
    reconnect: 'Reconnect needed',
    error: 'Error',
  }
  return (
    <span
      title={message ?? undefined}
      className={`text-xs font-medium px-2 py-0.5 rounded-full border ${styles[status]}`}
    >
      {labels[status]}
    </span>
  )
}

export default function BankItemCard({ item, onReconnect }: Props) {
  const qc = useQueryClient()
  // plaid_accounts.item_id is the Plaid-side string id, not the DB uuid — match it.
  const accountsQuery = usePlaidAccounts(item.item_id)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmForceResync, setConfirmForceResync] = useState(false)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const syncMutation = useMutation({
    // Mutation key uses the DB uuid purely as a client-side discriminator
    // so each card has its own loading state.
    mutationKey: ['plaidSync', item.id],
    mutationFn: (params: { reset_cursor?: boolean }) =>
      plaidSyncTransactions({ item_id: item.item_id, ...params }),
    onSuccess: (data) => {
      const n = data?.inserted
      setSuccessMsg(
        typeof n === 'number'
          ? `Synced ${n} new transaction${n === 1 ? '' : 's'} from ${item.institution_name ?? 'this bank'}`
          : 'Sync complete'
      )
      qc.invalidateQueries({ queryKey: ['plaid_items'] })
      qc.invalidateQueries({ queryKey: ['plaid_accounts', item.item_id] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      window.setTimeout(() => setSuccessMsg(null), 4000)
    },
  })

  const removeMutation = useMutation({
    mutationFn: () => plaidRemoveItem(item.item_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaid_items'] })
    },
  })

  const status = getItemStatus(item, syncMutation.isPending)

  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      <div className="flex items-center justify-between p-4 border-b border-gray-100">
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900 truncate">
              {item.institution_name ?? 'Unknown institution'}
            </div>
            <div className="text-xs text-gray-500">
              {relativeTime(item.last_synced_at)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={status} message={item.error_message} />
          {status === 'reconnect' && (
            <button
              type="button"
              onClick={onReconnect}
              className="text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded px-2 py-1"
            >
              Reconnect
            </button>
          )}
          <button
            type="button"
            onClick={() => syncMutation.mutate({})}
            disabled={syncMutation.isPending}
            className="flex items-center gap-1 text-xs font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 rounded px-2 py-1 disabled:opacity-50"
          >
            <RefreshCw size={12} className={syncMutation.isPending ? 'animate-spin' : ''} />
            Sync Now
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen(v => !v)}
              className="p-1 text-gray-400 hover:text-gray-700"
              aria-label="More"
            >
              <MoreVertical size={16} />
            </button>
            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-md z-10"
                onMouseLeave={() => setMenuOpen(false)}
              >
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); setConfirmForceResync(true) }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                >
                  Force Full Resync
                </button>
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); setConfirmDisconnect(true) }}
                  className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {successMsg && (
        <div className="px-4 py-2 text-xs text-green-700 bg-green-50 border-b border-green-100">
          ✓ {successMsg}
        </div>
      )}
      {syncMutation.isError && (
        <div className="px-4 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">
          {(syncMutation.error as Error).message}
        </div>
      )}
      {removeMutation.isError && (
        <div className="px-4 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">
          {(removeMutation.error as Error).message}
        </div>
      )}

      <ul className="py-2">
        {accountsQuery.isPending && (
          <li className="px-4 py-2 text-xs text-gray-400">Loading accounts…</li>
        )}
        {(accountsQuery.data ?? []).map(a => (
          <AccountRow key={a.id} account={a} />
        ))}
        {accountsQuery.data && accountsQuery.data.length === 0 && (
          <li className="px-4 py-2 text-xs text-gray-400">No accounts under this institution.</li>
        )}
      </ul>

      <ConfirmDialog
        open={confirmDisconnect}
        title={`Disconnect ${item.institution_name ?? 'this bank'}?`}
        message="Future syncs will stop. Past transactions will remain on your Expenses page and continue to count for Schedule C."
        loading={removeMutation.isPending}
        onConfirm={() => { removeMutation.mutate(); setConfirmDisconnect(false) }}
        onCancel={() => setConfirmDisconnect(false)}
      />

      <ConfirmDialog
        open={confirmForceResync}
        title={`Re-import all transactions from ${item.institution_name ?? 'this bank'}?`}
        message="This may take up to a minute and will pull historical data again."
        loading={syncMutation.isPending}
        onConfirm={() => { syncMutation.mutate({ reset_cursor: true }); setConfirmForceResync(false) }}
        onCancel={() => setConfirmForceResync(false)}
      />
    </div>
  )
}
```

- [ ] **Step 2: Confirm `ConfirmDialog` prop shape**

```bash
grep -n "ConfirmDialog\s*({" src/components/ConfirmDialog.tsx
```

If the props are `{ open, title, message, onConfirm, onCancel, loading? }`, the code above is correct. If they differ (e.g. `body` instead of `message`, or `confirmLabel`), adjust the two `<ConfirmDialog>` invocations to match.

- [ ] **Step 3: Verify build + lint**

```bash
npm run build && npm run lint
```

Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pages/settings/BankItemCard.tsx
git commit -m "feat(settings): BankItemCard with sync, resync, disconnect, reconnect"
```

---

## Task 10: Build the `BankConnectionsSection` component

**Files:**
- Create: `src/pages/settings/BankConnectionsSection.tsx`

- [ ] **Step 1: Write the section**

```tsx
// src/pages/settings/BankConnectionsSection.tsx
import { Building2, Plus } from 'lucide-react'
import type { PlaidItem } from '../../lib/types'
import { usePlaidItems } from '../../lib/queries'
import BankItemCard from './BankItemCard'

interface Props {
  /** Triggered by both the header "Connect Bank" button and the empty-state button. */
  onConnect: () => void
  /** Triggered by an item's "Reconnect" button — parent launches Plaid Link in update mode. */
  onReconnect: (item: PlaidItem) => void
  /** Optional inline error (e.g. from a link-token fetch failure in the parent). */
  errorMessage?: string | null
  /** True when the link-token fetch / exchange is in flight in the parent. */
  busy?: boolean
}

export default function BankConnectionsSection({ onConnect, onReconnect, errorMessage, busy }: Props) {
  const itemsQuery = usePlaidItems()
  const items = itemsQuery.data ?? []

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 size={18} className="text-gray-500" />
          <h2 className="text-lg font-semibold text-gray-900">
            Bank Connections
            {items.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">({items.length})</span>
            )}
          </h2>
        </div>
        <button
          type="button"
          onClick={onConnect}
          disabled={busy}
          className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors disabled:opacity-50"
        >
          <Plus size={14} /> Connect Bank
        </button>
      </header>

      {errorMessage && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {errorMessage}
        </div>
      )}

      {itemsQuery.isPending && (
        <div className="space-y-2">
          <div className="h-20 bg-gray-100 rounded-lg animate-pulse" />
          <div className="h-20 bg-gray-100 rounded-lg animate-pulse" />
        </div>
      )}

      {itemsQuery.isError && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-3">
          Couldn't load bank connections. {(itemsQuery.error as Error).message}
        </div>
      )}

      {!itemsQuery.isPending && items.length === 0 && (
        <div className="text-center py-12 border border-dashed border-gray-200 rounded-lg">
          <Building2 size={28} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-600 mb-3">
            Connect your first bank to start auto-importing transactions.
          </p>
          <button
            type="button"
            onClick={onConnect}
            disabled={busy}
            className="inline-flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            <Plus size={14} /> Connect Bank
          </button>
        </div>
      )}

      {items.map(item => (
        <BankItemCard key={item.id} item={item} onReconnect={() => onReconnect(item)} />
      ))}
    </section>
  )
}
```

- [ ] **Step 2: Verify build + lint**

```bash
npm run build && npm run lint
```

Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add src/pages/settings/BankConnectionsSection.tsx
git commit -m "feat(settings): BankConnectionsSection list + empty/loading states"
```

---

## Task 11: Wire `SettingsPage.tsx` — Plaid Link flow + Custom Categories section

This task replaces the placeholder body. The page owns the `usePlaidLink` lifecycle for both create-mode (header button + empty state button) and update-mode (Reconnect on individual cards).

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Replace the placeholder with the real page**

```tsx
// src/pages/SettingsPage.tsx
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link'
import type { PlaidItem } from '../lib/types'
import { plaidCreateLinkToken, plaidExchangeToken } from '../lib/mutations'
import BankConnectionsSection from './settings/BankConnectionsSection'
import CustomCategoriesList from '../components/CustomCategoriesList'

export default function SettingsPage() {
  const qc = useQueryClient()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [updateItemId, setUpdateItemId] = useState<string | undefined>()
  const plaidEnv = import.meta.env.VITE_PLAID_ENV as string | undefined

  const createTokenMutation = useMutation({
    mutationFn: (itemId?: string) => plaidCreateLinkToken(itemId),
    onSuccess: ({ link_token }) => setLinkToken(link_token),
    onError: (e: Error) => setLinkError(e.message),
  })

  const exchangeTokenMutation = useMutation({
    mutationFn: (params: { public_token: string; metadata: PlaidLinkOnSuccessMetadata }) =>
      plaidExchangeToken(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaid_items'] })
      qc.invalidateQueries({ queryKey: ['plaid_accounts'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      setUpdateItemId(undefined)
    },
    onError: (e: Error) => setLinkError(e.message),
  })

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (public_token, metadata) => {
      exchangeTokenMutation.mutate({ public_token, metadata })
      setLinkToken(null)
    },
    onExit: (err) => {
      if (err) setLinkError(`Plaid Link closed with an error: ${err.error_message ?? err.error_code}`)
      setLinkToken(null)
    },
  })

  useEffect(() => {
    if (linkToken && ready) open()
  }, [linkToken, ready, open])

  function handleConnect() {
    setLinkError(null)
    setUpdateItemId(undefined)
    createTokenMutation.mutate(undefined)
  }

  function handleReconnect(item: PlaidItem) {
    setLinkError(null)
    setUpdateItemId(item.id)
    createTokenMutation.mutate(item.item_id)
  }

  const busy = createTokenMutation.isPending || exchangeTokenMutation.isPending

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-10">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage bank connections and custom categories
        </p>
      </header>

      <BankConnectionsSection
        onConnect={handleConnect}
        onReconnect={handleReconnect}
        errorMessage={linkError}
        busy={busy}
      />

      <section className="space-y-3">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Custom Categories</h2>
        </header>
        <div className="border border-gray-200 rounded-lg bg-white p-4">
          <CustomCategoriesList />
        </div>
      </section>

      {plaidEnv && plaidEnv !== 'production' && (
        <div className="text-xs text-gray-400 text-center pt-6">
          Plaid env: {plaidEnv}
        </div>
      )}
    </div>
  )
}
```

Notes for the implementer:
- `updateItemId` is tracked for future use (e.g. surfacing which card triggered the flow); the current behavior simply scopes invalidation after exchange. The `react-plaid-link` `onSuccess` callback doesn't need the item id — Plaid identifies the institution by the public_token.
- `usePlaidLink({ token: null })` is safe; the hook only opens when a non-null token is provided.

- [ ] **Step 2: Verify build + lint**

```bash
npm run build && npm run lint
```

Expected: both PASS. If `react-plaid-link` type imports differ in your installed version, adjust the `PlaidLinkOnSuccessMetadata` import to whatever the package exports (e.g. some versions name it `PlaidLinkMetadata`).

- [ ] **Step 3: Run dev server, smoke-test mount**

```bash
npm run dev
```

Open `/settings`. Page renders:
- Header
- BankConnections section showing 3 existing items (or skeleton on first load)
- Custom Categories section showing the same body as the existing modal

Click "Connect Bank" — Plaid Link iframe should open in sandbox (assuming the edge function returns a sandbox token). Cancel out without finishing — no errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat(settings): SettingsPage with Plaid Link flow + Custom Categories"
```

---

## Task 12: Add `docs/features/settings.md` and update `docs/README.md`

**Files:**
- Create: `docs/features/settings.md`
- Modify: `docs/README.md` (link the new doc)

- [ ] **Step 1: Write the feature doc**

```markdown
# Settings page

Path: `/settings` → [src/pages/SettingsPage.tsx](../../src/pages/SettingsPage.tsx)

The Settings page hosts cross-cutting account configuration. v1 has two sections, stacked
vertically on a single scrollable page.

## Bank Connections

Lists every connected Plaid institution from `plaid_items`, with the accounts under each
institution from `plaid_accounts`.

- **Connect Bank** — launches Plaid Link in create mode. On success the
  `plaid_exchange_token` edge function persists a new `plaid_items` row + its
  `plaid_accounts`. React Query invalidations refresh the list.
- **Sync Now** — per-item button calling `plaid_sync_transactions`. Surfaces an inline
  success line with the count of newly-inserted transactions when the function returns one.
- **Force Full Resync** — kebab menu → confirm dialog → `plaid_sync_transactions` with
  `reset_cursor: true`. Backend dependency: the edge function must accept the flag and
  clear `plaid_items.cursor`. If the flag is ignored, this silently degrades to a normal
  Sync Now.
- **Reconnect** — appears as a red button when `plaid_items.status = 'login_required'`.
  Launches Plaid Link in update mode (passes `item_id` to `plaid_create_link_token`).
- **Disconnect** — kebab menu → confirm dialog → `plaid_remove_item`. Historical
  transactions are retained with `source = 'plaid'`; the `account_display` column on
  each transaction keeps the institution + mask readable on the Expenses page.

### Per-account controls

Each `plaid_account` row supports:
- Inline rename (`display_name` column), pencil icon → input.
- `sync_enabled` checkbox — direct table update. Backend is expected to honor this on
  the next sync.

### Status badge

Driven by [`itemStatus.ts`](../../src/pages/settings/itemStatus.ts):

| Badge | When |
|---|---|
| Connected (green) | `status = 'active'` and no sync in flight |
| Syncing… (amber) | `plaidSyncTransactions` mutation in flight for this `item_id` |
| Reconnect needed (red) | `status = 'login_required'` — Plaid returned `ITEM_LOGIN_REQUIRED` |
| Error (red) | `status = 'error'` — tooltip shows `error_message` |

If the `status` column is absent (migration not applied), the helper treats it as
`'active'` so the UI degrades gracefully.

## Custom Categories

Renders [`CustomCategoriesList`](../../src/components/CustomCategoriesList.tsx) — the same
component used by `ManageCategoriesModal`. The list view is identical to the modal except
the "Done" button is omitted (no modal to dismiss). See
[categories.md](categories.md) (if present) or
[`docs/superpowers/specs/2026-06-25-custom-categories-design.md`](../superpowers/specs/2026-06-25-custom-categories-design.md)
for the underlying category model.

## Backend dependencies

The following edge function / schema changes must land in parallel with this page for
full functionality (page works without them, degrading gracefully):

1. `plaid_items.status` + `error_message` columns — migration `plaid_item_status`.
2. `plaid_sync_transactions` — accept `{ item_id, reset_cursor?: boolean }`; when
   `reset_cursor = true`, clear `cursor` before pulling. Set `plaid_items.status =
   'login_required'` + `error_message` on `ITEM_LOGIN_REQUIRED`.
3. `plaid_exchange_token` — when called for update mode (existing `item_id`), reset
   `plaid_items.status = 'active'` and clear `error_message` on success.
```

- [ ] **Step 2: Link from `docs/README.md`**

In `docs/README.md`, find the features section and add a line linking `features/settings.md`. Mimic the surrounding lines' formatting. Example, if the file lists `[dashboard.md](features/dashboard.md) — ...`, add:

```markdown
- [settings.md](features/settings.md) — Settings page (Plaid bank connections + custom categories)
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/settings.md docs/README.md
git commit -m "docs(settings): add settings feature doc"
```

---

## Task 13: End-to-end manual test pass

This task is verification, not implementation. Run each step against the dev server with the sandbox Plaid env. Mark the box only after you've personally observed the expected outcome.

**Files:** none modified.

- [ ] **Step 1: Boot the dev server fresh**

```bash
npm run dev
```

Open the app, sign in.

- [ ] **Step 2: Settings page renders**

Click "Settings" in the sidebar. Header, both sections, and footer pill (when env != production) all render. No console errors.

- [ ] **Step 3: Existing items appear**

The 3 existing `plaid_items` rows render as cards, each with their accounts collapsed under them. All show "Connected" badge. Edit a `display_name` on one account — reload — change persists.

- [ ] **Step 4: Sync Now**

Click Sync Now on one card. Badge flips to "Syncing…". On success, green inline line appears: "Synced N new transactions from {institution}". `last_synced_at` updates.

- [ ] **Step 5: Per-account sync_enabled**

Toggle one account's "Sync" checkbox off. Click Sync Now on that card. Verify (via SQL or by checking `transactions` count change) that no new transactions appear for that account. Toggle back on.

- [ ] **Step 6: Force Full Resync**

Kebab → Force Full Resync → confirm. Watch the spinner. On completion, the cursor should be cleared (verify via SQL: `select cursor from plaid_items where id = '<id>'` — should be null or refilled with a new cursor after re-pull). If backend doesn't support `reset_cursor` yet, this behaves like Sync Now — note the gap and surface to the backend owner.

- [ ] **Step 7: ITEM_LOGIN_REQUIRED + Reconnect**

In Plaid sandbox dashboard, call `/sandbox/item/reset_login` for one of the items. Run Sync Now — backend should set `plaid_items.status = 'login_required'`. The card's badge flips red and "Reconnect" button appears. Click Reconnect → Plaid Link opens in update mode. Complete it. Badge returns to green. Sync Now succeeds.

(If the backend hasn't been updated to write `status = 'login_required'`, this won't work end-to-end. Note as a backend coordination gap.)

- [ ] **Step 8: Connect a new bank**

Click "Connect Bank". Use sandbox credentials `user_good` / `pass_good`. Complete the flow. A new card appears with its accounts. Sync Now on the new card pulls transactions.

- [ ] **Step 9: Disconnect**

Kebab → Disconnect → confirm. Card disappears. Navigate to Expenses — past transactions from that bank are still present, still show the Plaid badge, still show their `account_display`.

- [ ] **Step 10: Custom Categories parity**

In the Custom Categories section, add a new category. Navigate to Expenses, open a transaction's category dropdown — the new category appears. From the dropdown, click "Manage categories" — the modal opens with the same body, including the new category. Edit/delete behavior matches the inline section.

- [ ] **Step 11: CI gates**

```bash
npm run build && npm run lint && npx vitest run
```

Expected: all three PASS. Vitest should include the new `itemStatus.test.ts` (5 passing).

- [ ] **Step 12: Commit any fixes**

If any step surfaced a fix, commit it before declaring done.

---

## Task 14: Final spec-coverage sweep + PR

- [ ] **Step 1: Cross-check spec against implementation**

Open [docs/superpowers/specs/2026-06-25-settings-and-plaid-design.md](../specs/2026-06-25-settings-and-plaid-design.md). Walk every numbered section / table row and confirm a task touched it. Specifically:

  - §Routing & nav → Task 7
  - §Page shell → Task 7 / 11
  - §Data hooks → Task 3
  - §Mutations → Task 4
  - §Bank Connections UI → Tasks 8–11
  - §Status badge → Task 5 (helper) + Task 9 (rendering)
  - §Plaid Link flow → Task 11
  - §Sync controls → Task 9 (per-item card)
  - §Disconnect flow → Task 9
  - §Per-account controls → Task 8
  - §Schema migration → Task 2
  - §Custom Categories section → Task 6 (extraction) + Task 11 (composition)
  - §Notification convention → Task 9 (success/error inline patterns)
  - §Error handling & edge cases → Tasks 9 + 11 (errors), Task 5 (graceful degrade)
  - §Testing strategy → Task 5 (unit) + Task 13 (manual)

If any row has no corresponding task, write one before opening the PR.

- [ ] **Step 2: Final build**

```bash
npm run build && npm run lint && npx vitest run
```

- [ ] **Step 3: Open PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(settings): Settings page + Plaid Link for Web" --body "$(cat <<'EOF'
## Summary
- Adds the web client's first Settings page at `/settings` with stacked Bank Connections + Custom Categories sections
- Wires Plaid Link for Web (create + update modes), Sync Now, Force Full Resync, Disconnect, and per-account display_name + sync_enabled controls
- Extracts `CustomCategoriesList` from `ManageCategoriesModal` so the same UI renders inside Settings and in-context dropdowns
- Adds a small `plaid_items.status` + `error_message` migration; client treats absent columns as `'active'`

## Test plan
- [x] Vitest unit tests for `getItemStatus` (5 cases)
- [ ] Manual: connect new bank in Plaid sandbox, Sync Now, Force Full Resync, ITEM_LOGIN_REQUIRED → Reconnect (update mode), Disconnect → transactions retained on Expenses
- [ ] Manual: per-account rename + sync_enabled toggle round-trip
- [ ] Manual: Custom Categories add/edit/delete works inline and via the existing modal

## Backend coordination
- `plaid_sync_transactions` should accept `{ reset_cursor }` and write `status = 'login_required'` on `ITEM_LOGIN_REQUIRED`
- `plaid_exchange_token` should reset `status = 'active'` on successful update-mode exchange
- Both already work to degrade gracefully if not yet updated

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the implementer

- **Frequent commits.** Every task ends with a commit; don't bundle. If a task feels too big, split it.
- **No premature abstraction.** Several components (e.g. `BankItemCard`) could be split into smaller pieces — they aren't, because they have one consumer.
- **No new test files for uncovered areas.** Per CLAUDE.md: "Add tests when you touch covered files; don't add brand-new test files for uncovered areas unless explicitly asked." The exception here is `itemStatus.test.ts` — that helper is the one piece of pure logic worth a spec, and the file is colocated with the helper. Don't write component-level tests; rely on Task 13's manual pass.
- **No toast library.** Inline success/error messages only, matching `TransactionInventorySection` / `EditLotModal` precedent.
- **Defensive treatment of `plaid_items.status`.** The `getItemStatus` helper accepts an undefined `status` and falls back to `'connected'`. This is by design so the page works before the migration lands.
