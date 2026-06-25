# Custom Schedule C Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship user-defined Schedule C categories — stored in Supabase, tax-aware (hybrid: inherit from a built-in or pick a Schedule C line directly), with inline management from the Expenses category dropdowns. Closes P0 guardrail #3 and the P1 "Custom Schedule C categories" item.

**Architecture:**
- New `custom_categories` table; user's rows fetched by a React Query hook and resolved client-side via a new `resolveCategory()` helper that subsumes `getCategoryDef()` for any code path touching real transaction data.
- `bucketTransaction(t, customs)` gains a `customs` parameter; the three Dashboard aggregates (`computeKPIs`, `computeMonthlyChart`, `computeScheduleC`) forward it.
- All three category-picker surfaces (Expenses filter dropdown, Expenses detail-pane `CategoryDropdown`, `AddTransactionModal` `<select>`) converge on a single `<ManageCategoriesModal/>` for CRUD. Soft-delete tombstones keep historical Schedule C math intact.

**Tech Stack:** Vite + React 19 + TypeScript, `@supabase/supabase-js`, `@tanstack/react-query`, Tailwind v4, React Router v7. No test suite (per CLAUDE.md, do not add tests unless asked). Verification = `npm run build` + `npm run lint` + manual dev-server smoke test.

**Spec:** [`docs/superpowers/specs/2026-06-25-custom-categories-design.md`](../specs/2026-06-25-custom-categories-design.md)

---

## File structure

**Create:**
- `supabase/migrations/20260625120000_custom_categories.sql` — table, indexes, RLS, CHECK constraint.
- `src/lib/categoryPalette.ts` — `PALETTE` and `ColorKey` type. Self-contained, no other deps.
- `src/components/modals/ManageCategoriesModal.tsx` — list + inline create/edit form.

**Modify:**
- `src/lib/types.ts` — add `CustomCategory` interface (or co-locate in `categories.ts` — see Task 3).
- `src/lib/categories.ts` — add `CustomCategory` interface, `resolveCategory()`, change `bucketTransaction` signature.
- `src/lib/scheduleCMath.ts` — `computeScheduleC`/`computeKPIs`/`computeMonthlyChart` accept and forward `customs`.
- `src/lib/queries.ts` — new `useCustomCategories()` hook + `activeCustomCategories()` selector.
- `src/lib/mutations.ts` — `createCustomCategory` / `updateCustomCategory` / `deleteCustomCategory`.
- `src/components/CategoryBadge.tsx` — call `resolveCategory` via `useCustomCategories` instead of `getCategoryDef`.
- `src/pages/DashboardPage.tsx` — fetch customs; forward to aggregates; merge customs into the partI/II/III filter lists.
- `src/pages/ExpensesPage.tsx` — convert top-of-page filter `<select>` to a custom dropdown; update inline `CategoryDropdown` (lines ~52–84 and ~272–292) to render custom-category section + "Manage" footer.
- `src/components/modals/AddTransactionModal.tsx` — replace `<select>` with the same custom dropdown pattern + "Manage" footer.
- `docs/supabase-schema.md`, `docs/categories.md`, `docs/features/expenses.md`, `TASKS.md` — sync to shipped state.

**File size sanity check:** `ExpensesPage.tsx` is already 570 lines — splitting `CategoryDropdown` into its own component (`src/components/CategoryDropdown.tsx`) is in-scope cleanup since this plan modifies it; the dropdown becomes the shared surface used by ExpensesPage + AddTransactionModal.

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/20260625120000_custom_categories.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- custom_categories: per-user, tax-aware Schedule C categories.
--
-- Two modes, mutually exclusive (CHECK):
--   * parent_value NOT NULL: inherits scheduleLine/mealsHalf/isExcluded from the built-in.
--   * schedule_line NOT NULL: explicit Schedule C line (Part I / Part III / Line 8…30,
--     excluding Line 24b which must go via parent_value='meals' for the 50% deduction).
--
-- Soft-delete with deleted_at. Tombstoned rows are still SELECT-able so
-- transactions referencing them resolve correctly (badge shows "(deleted)").
--
-- See docs/superpowers/specs/2026-06-25-custom-categories-design.md.

create table public.custom_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  name text not null check (length(trim(name)) > 0 and length(name) <= 40),
  color_key text not null,
  parent_value text,
  schedule_line text,
  constraint custom_categories_one_of_parent_or_line
    check ((parent_value is not null) <> (schedule_line is not null))
);

create index custom_categories_user_id_idx on public.custom_categories(user_id);
create index custom_categories_user_active_idx
  on public.custom_categories(user_id) where deleted_at is null;

alter table public.custom_categories enable row level security;

create policy "custom_categories_owner_select" on public.custom_categories
  for select using (auth.uid() = user_id);
create policy "custom_categories_owner_insert" on public.custom_categories
  for insert with check (auth.uid() = user_id);
create policy "custom_categories_owner_update" on public.custom_categories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "custom_categories_owner_delete" on public.custom_categories
  for delete using (auth.uid() = user_id);
```

- [ ] **Step 2: Apply the migration via the Supabase MCP**

Use the `mcp__supabase__apply_migration` tool:
- `name`: `custom_categories`
- `query`: the full SQL from Step 1

Expected: migration applied successfully.

- [ ] **Step 3: Verify the table exists and RLS is enforced**

Use `mcp__supabase__list_tables` (schema: `public`); confirm `custom_categories` appears with the four columns + RLS enabled.

Then `mcp__supabase__execute_sql` with:
```sql
insert into custom_categories (user_id, name, color_key, parent_value)
values (gen_random_uuid(), 'Test', 'rose', 'commissions_fees');
```
Expected: fails because RLS rejects anon write (or auth.uid() doesn't match). This proves RLS is on. Clean up if it succeeded.

Test the CHECK:
```sql
-- Should fail: both null
insert into custom_categories (user_id, name, color_key) values (auth.uid(), 'X', 'rose');
-- Should fail: both set
insert into custom_categories (user_id, name, color_key, parent_value, schedule_line)
values (auth.uid(), 'X', 'rose', 'commissions_fees', 'Line 10');
```
Both expected to violate `custom_categories_one_of_parent_or_line`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260625120000_custom_categories.sql
git commit -m "feat(custom-categories): add custom_categories table + RLS"
```

---

## Task 2: Color palette module

**Files:**
- Create: `src/lib/categoryPalette.ts`

- [ ] **Step 1: Write the palette**

```ts
// 12-swatch fixed palette for custom Schedule C categories.
// Each entry is a (text-color, background-color) pair tuned to look like
// the built-in CATEGORIES badges. The color_key column on custom_categories
// stores one of these keys; resolveCategory() looks up the swatch at render.

export type ColorKey =
  | 'emerald' | 'sky'   | 'rose'   | 'amber'
  | 'violet'  | 'slate' | 'orange' | 'teal'
  | 'indigo'  | 'pink'  | 'lime'   | 'cyan'

export const PALETTE: Record<ColorKey, { color: string; bgColor: string }> = {
  emerald: { color: '#059669', bgColor: '#d1fae5' },
  sky:     { color: '#0284c7', bgColor: '#e0f2fe' },
  rose:    { color: '#e11d48', bgColor: '#ffe4e6' },
  amber:   { color: '#d97706', bgColor: '#fef3c7' },
  violet:  { color: '#7c3aed', bgColor: '#ede9fe' },
  slate:   { color: '#6b7280', bgColor: '#f3f4f6' },
  orange:  { color: '#ea580c', bgColor: '#ffedd5' },
  teal:    { color: '#0d9488', bgColor: '#ccfbf1' },
  indigo:  { color: '#4f46e5', bgColor: '#eef2ff' },
  pink:    { color: '#db2777', bgColor: '#fce7f3' },
  lime:    { color: '#65a30d', bgColor: '#ecfccb' },
  cyan:    { color: '#0891b2', bgColor: '#cffafe' },
}

export const PALETTE_KEYS: ColorKey[] = Object.keys(PALETTE) as ColorKey[]

export function isColorKey(s: string): s is ColorKey {
  return (PALETTE_KEYS as string[]).includes(s)
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS (no usages yet, but the file must type-check).

- [ ] **Step 3: Commit**

```bash
git add src/lib/categoryPalette.ts
git commit -m "feat(custom-categories): add fixed color palette"
```

---

## Task 3: CustomCategory type + resolveCategory helper

**Files:**
- Modify: `src/lib/categories.ts`

- [ ] **Step 1: Add the `CustomCategory` type and `resolveCategory` helper**

At the top of `src/lib/categories.ts`, after the existing imports/`CategoryDef` interface, add:

```ts
import { PALETTE, type ColorKey } from './categoryPalette'

export interface CustomCategory {
  id: string
  /** Stored on transactions.schedule_c_category. Format: 'cust_<uuid-no-hyphens>'. */
  value: string
  name: string
  colorKey: ColorKey
  /** If non-null, inherits scheduleLine/mealsHalf/isExcluded from this built-in CategoryDef.value. */
  parentValue: string | null
  /** If non-null, explicit Schedule C line (mutually exclusive with parentValue). */
  scheduleLine: string | null
  deletedAt: string | null
}

/** Construct the on-the-wire value string for a custom category row. */
export function customCategoryValue(id: string): string {
  return `cust_${id.replace(/-/g, '')}`
}
```

Add `resolveCategory` after the existing `getCategoryDef` (around line 47):

```ts
/**
 * Resolves a schedule_c_category string to a CategoryDef-shaped record,
 * checking built-ins first, then customs. Returns undefined for unknown values.
 *
 * For custom categories with parent_value set, inherits scheduleLine / mealsHalf /
 * isExcluded from the parent built-in. Tombstoned customs are still resolved
 * (label suffixed " (deleted)") so historical transactions render and bucket correctly.
 *
 * This is the ONLY lookup used by code paths that touch real transaction data
 * (bucketTransaction, dashboard render, badges). getCategoryDef remains for
 * pure-built-in render paths (e.g. iterating CATEGORIES for picker swatches).
 */
export function resolveCategory(
  value: string | null | undefined,
  customs: CustomCategory[],
): CategoryDef | undefined {
  if (!value) return undefined

  const builtIn = CATEGORIES.find(c => c.value === value)
  if (builtIn) return builtIn

  const custom = customs.find(c => c.value === value)
  if (!custom) return undefined

  const swatch = PALETTE[custom.colorKey]
  const labelSuffix = custom.deletedAt ? ' (deleted)' : ''

  if (custom.parentValue) {
    const parent = CATEGORIES.find(c => c.value === custom.parentValue)
    if (!parent) return undefined
    return {
      value: custom.value,
      label: custom.name + labelSuffix,
      color: swatch.color,
      bgColor: swatch.bgColor,
      isExcluded: parent.isExcluded,
      mealsHalf: parent.mealsHalf,
      scheduleLine: parent.scheduleLine,
    }
  }

  return {
    value: custom.value,
    label: custom.name + labelSuffix,
    color: swatch.color,
    bgColor: swatch.bgColor,
    isExcluded: false,
    scheduleLine: custom.scheduleLine ?? undefined,
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS — `resolveCategory` defined but not yet called.

- [ ] **Step 3: Commit**

```bash
git add src/lib/categories.ts
git commit -m "feat(custom-categories): add CustomCategory type and resolveCategory helper"
```

---

## Task 4: `bucketTransaction` signature change + aggregate updates

**Files:**
- Modify: `src/lib/categories.ts` (line 70 — `bucketTransaction`)
- Modify: `src/lib/scheduleCMath.ts` (all three exports)

- [ ] **Step 1: Update `bucketTransaction` signature**

Replace the `bucketTransaction` function in `src/lib/categories.ts` (currently lines 70–92):

```ts
/**
 * Single source of truth for "does this transaction count toward Schedule C, and if so where?"
 *
 * `customs` is the user's full custom-categories list (including tombstoned rows);
 * pass it through from a useCustomCategories() hook at the call-site. For purely
 * built-in workflows, pass an empty array.
 *
 * Returns SIGNED amounts (a refund posted to an expense category comes back as positive,
 * which correctly offsets the negative expense amounts when summed). Callers should sum
 * signedAmount per categoryValue and only abs() at display time.
 */
export function bucketTransaction(t: Transaction, customs: CustomCategory[]): BucketedAmount {
  const none: BucketedAmount = { bucket: null, categoryValue: null, signedAmount: 0 }

  if (t.record_type === 'settlement') return none
  if (t.related_sale_id) return none
  if (t.source === 'csv_import') return none
  if (t.net_zero_pair_id) return none
  if (!t.schedule_c_category) return none

  const cat = resolveCategory(t.schedule_c_category, customs)
  if (!cat) return none
  if (cat.isExcluded) return none

  const mult = cat.mealsHalf ? 0.5 : 1
  const signed = t.amount * mult

  if (cat.scheduleLine === 'Part I') {
    return { bucket: 'income', categoryValue: t.schedule_c_category, signedAmount: signed }
  }
  if (cat.scheduleLine === 'Part III') {
    return { bucket: 'cogs', categoryValue: t.schedule_c_category, signedAmount: signed }
  }
  return { bucket: 'expense', categoryValue: t.schedule_c_category, signedAmount: signed }
}
```

Note: the existing "Future work: when custom_categories ships…" docblock at the top of the old function is removed — this IS that work.

- [ ] **Step 2: Update `scheduleCMath.ts` exports to accept customs**

Replace the entire content of `src/lib/scheduleCMath.ts`:

```ts
import { bucketTransaction, type CustomCategory } from './categories'
import type { Transaction } from './types'
import { monthKey } from './utils'

/** Sum of signed amounts per Schedule C category. Sum is signed (refunds against expenses reduce expense totals). */
export function computeScheduleC(
  transactions: Transaction[],
  customs: CustomCategory[],
): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === null || b.categoryValue === null) continue
    totals[b.categoryValue] = (totals[b.categoryValue] ?? 0) + b.signedAmount
  }
  return totals
}

export interface KPITotals {
  income: number
  expenses: number
  net: number
}

/** Period-scoped income, expenses, and net for the dashboard KPI row. */
export function computeKPIs(
  transactions: Transaction[],
  customs: CustomCategory[],
): KPITotals {
  let incomeSum = 0
  let expenseSum = 0
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === 'income') incomeSum += b.signedAmount
    else if (b.bucket === 'expense' || b.bucket === 'cogs') expenseSum += b.signedAmount
  }
  return {
    income: incomeSum,
    expenses: Math.abs(expenseSum),
    net: incomeSum + expenseSum,
  }
}

export interface MonthlyBar {
  month: string
  income: number
  expenses: number
}

/** Monthly income/expense bar chart data. */
export function computeMonthlyChart(
  transactions: Transaction[],
  customs: CustomCategory[],
): MonthlyBar[] {
  const months: Record<string, { income: number; expense: number }> = {}
  for (const t of transactions) {
    const b = bucketTransaction(t, customs)
    if (b.bucket === null) continue
    const key = monthKey(t.date)
    if (!months[key]) months[key] = { income: 0, expense: 0 }
    if (b.bucket === 'income') months[key].income += b.signedAmount
    else months[key].expense += b.signedAmount
  }
  return Object.keys(months)
    .sort()
    .map(month => ({
      month,
      income: months[month].income,
      expenses: Math.abs(months[month].expense),
    }))
}
```

- [ ] **Step 3: Update existing callers to pass `customs: []`**

Build will fail until callers pass the new arg. Until the `useCustomCategories()` hook is wired in (Task 8 for DashboardPage), patch the only other caller — `src/lib/saleProfit.ts` if it imports `bucketTransaction` (check via `grep`):

```bash
grep -rn "bucketTransaction\|computeScheduleC\|computeKPIs\|computeMonthlyChart" src/
```

Expected callers from the spec:
- `src/pages/DashboardPage.tsx` lines 131, 133, 134 — temporarily pass `[]` here; Task 8 wires the real hook.

Patch DashboardPage now with stubs:
```ts
const kpis = useMemo(() => computeKPIs(transactions, []), [transactions])
const monthlyData = useMemo(() => computeMonthlyChart(transactions, []), [transactions])
const scheduleC = useMemo(() => computeScheduleC(transactions, []), [transactions])
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS.

Run: `npm run lint`
Expected: PASS (no new warnings).

- [ ] **Step 5: Commit**

```bash
git add src/lib/categories.ts src/lib/scheduleCMath.ts src/pages/DashboardPage.tsx
git commit -m "refactor(custom-categories): bucketTransaction takes customs param"
```

---

## Task 5: `useCustomCategories` query hook

**Files:**
- Modify: `src/lib/queries.ts`

- [ ] **Step 1: Add the hook + selector**

Append to `src/lib/queries.ts`:

```ts
import type { CustomCategory } from './categories'
import { customCategoryValue } from './categories'
import type { ColorKey } from './categoryPalette'

/**
 * Fetches the user's custom Schedule C categories, including tombstoned rows.
 * Resolution helpers (resolveCategory) need tombstoned rows to render historical
 * transactions; pickers should filter via activeCustomCategories(customs).
 */
export function useCustomCategories() {
  return useQuery({
    queryKey: ['custom_categories'],
    queryFn: async (): Promise<CustomCategory[]> => {
      const { data, error } = await supabase
        .from('custom_categories')
        .select('id, name, color_key, parent_value, schedule_line, deleted_at')
        .order('name')
      if (error) throw error
      return (data ?? []).map(r => ({
        id: r.id,
        value: customCategoryValue(r.id),
        name: r.name,
        colorKey: r.color_key as ColorKey,
        parentValue: r.parent_value,
        scheduleLine: r.schedule_line,
        deletedAt: r.deleted_at,
      }))
    },
  })
}

/** Active (non-tombstoned) custom categories for picker UIs. */
export function activeCustomCategories(customs: CustomCategory[]): CustomCategory[] {
  return customs.filter(c => !c.deletedAt)
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/queries.ts
git commit -m "feat(custom-categories): add useCustomCategories query hook"
```

---

## Task 6: CRUD mutations

**Files:**
- Modify: `src/lib/mutations.ts`

- [ ] **Step 1: Add the three mutation functions**

Append to `src/lib/mutations.ts`:

```ts
import { CATEGORIES } from './categories'
import { isColorKey, type ColorKey } from './categoryPalette'

// ─── Custom categories ────────────────────────────────────────────────────────

interface CustomCategoryInput {
  name: string
  colorKey: ColorKey
  parentValue: string | null  // exactly one of parentValue / scheduleLine must be non-null
  scheduleLine: string | null
}

const ALLOWED_SCHEDULE_LINES: string[] = (() => {
  const lines = new Set<string>(['Part I', 'Part III'])
  for (const c of CATEGORIES) {
    if (c.scheduleLine?.startsWith('Line ') && c.scheduleLine !== 'Line 24b') {
      lines.add(c.scheduleLine)
    }
  }
  return Array.from(lines)
})()

function validateCustomCategoryInput(input: Partial<CustomCategoryInput>): void {
  if (input.name !== undefined) {
    const trimmed = input.name.trim()
    if (trimmed.length === 0) throw new Error('Name is required')
    if (trimmed.length > 40) throw new Error('Name must be 40 characters or fewer')
  }
  if (input.colorKey !== undefined && !isColorKey(input.colorKey)) {
    throw new Error('Invalid color')
  }
  if (input.parentValue !== undefined && input.scheduleLine !== undefined) {
    const hasParent = input.parentValue !== null
    const hasLine = input.scheduleLine !== null
    if (hasParent === hasLine) {
      throw new Error('Pick either a parent category or a Schedule C line, not both')
    }
  }
  if (input.parentValue) {
    if (!CATEGORIES.find(c => c.value === input.parentValue)) {
      throw new Error(`Unknown parent category: ${input.parentValue}`)
    }
  }
  if (input.scheduleLine) {
    if (!ALLOWED_SCHEDULE_LINES.includes(input.scheduleLine)) {
      throw new Error(`Invalid Schedule C line: ${input.scheduleLine}`)
    }
  }
}

export async function createCustomCategory(input: CustomCategoryInput): Promise<string> {
  validateCustomCategoryInput(input)
  const user_id = await getUserId()

  // Soft uniqueness — block creating a second active row with the same name.
  const { data: existing } = await supabase
    .from('custom_categories')
    .select('id')
    .eq('user_id', user_id)
    .is('deleted_at', null)
    .ilike('name', input.name.trim())
    .limit(1)
  if (existing && existing.length > 0) {
    throw new Error(`A category named "${input.name.trim()}" already exists`)
  }

  const { data, error } = await supabase
    .from('custom_categories')
    .insert({
      user_id,
      name: input.name.trim(),
      color_key: input.colorKey,
      parent_value: input.parentValue,
      schedule_line: input.scheduleLine,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

export async function updateCustomCategory(
  id: string,
  patch: Partial<CustomCategoryInput>,
): Promise<void> {
  validateCustomCategoryInput(patch)

  // If patching name, recheck soft-uniqueness against the user's other active rows.
  if (patch.name !== undefined) {
    const user_id = await getUserId()
    const { data: existing } = await supabase
      .from('custom_categories')
      .select('id')
      .eq('user_id', user_id)
      .is('deleted_at', null)
      .neq('id', id)
      .ilike('name', patch.name.trim())
      .limit(1)
    if (existing && existing.length > 0) {
      throw new Error(`A category named "${patch.name.trim()}" already exists`)
    }
  }

  const row: Record<string, unknown> = {}
  if (patch.name !== undefined) row.name = patch.name.trim()
  if (patch.colorKey !== undefined) row.color_key = patch.colorKey
  if (patch.parentValue !== undefined) row.parent_value = patch.parentValue
  if (patch.scheduleLine !== undefined) row.schedule_line = patch.scheduleLine

  const { error } = await supabase.from('custom_categories').update(row).eq('id', id)
  if (error) throw error
}

export async function deleteCustomCategory(id: string): Promise<void> {
  const { error } = await supabase
    .from('custom_categories')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

/** Counts transactions referencing the custom category — used by the delete confirmation dialog. */
export async function countTransactionsUsingCustomCategory(customCategoryId: string): Promise<number> {
  const value = `cust_${customCategoryId.replace(/-/g, '')}`
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('schedule_c_category', value)
  if (error) throw error
  return count ?? 0
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mutations.ts
git commit -m "feat(custom-categories): add CRUD mutations + transaction count helper"
```

---

## Task 7: `CategoryBadge` integration

**Files:**
- Modify: `src/components/CategoryBadge.tsx`

- [ ] **Step 1: Switch from `getCategoryDef` to `resolveCategory` via the hook**

Replace `src/components/CategoryBadge.tsx` entirely:

```tsx
import { resolveCategory } from '../lib/categories'
import { useCustomCategories } from '../lib/queries'

interface Props {
  value?: string | null
  onClick?: (e: React.MouseEvent) => void
  size?: 'sm' | 'xs'
}

export default function CategoryBadge({ value, onClick, size = 'sm' }: Props) {
  const { data: customs = [] } = useCustomCategories()
  const def = resolveCategory(value, customs)
  const label = def?.label ?? (value ? value : '—')
  const style = def
    ? { color: def.color, backgroundColor: def.bgColor }
    : { color: '#9ca3af', backgroundColor: '#f3f4f6' }

  const cls = size === 'xs'
    ? 'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium'
    : 'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium'

  return (
    <span
      className={cls + (onClick ? ' cursor-pointer hover:opacity-80' : '')}
      style={style}
      onClick={onClick}
    >
      {label}
    </span>
  )
}
```

- [ ] **Step 2: Verify build + manual badge render**

Run: `npm run build`
Expected: PASS.

Run: `npm run dev`
Manually load the Expenses page. Expected: existing built-in badges render exactly as before (no custom categories exist yet, so behavior is unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/components/CategoryBadge.tsx
git commit -m "feat(custom-categories): CategoryBadge resolves custom categories"
```

---

## Task 8: `DashboardPage` integration

**Files:**
- Modify: `src/pages/DashboardPage.tsx`

- [ ] **Step 1: Wire `useCustomCategories` into the page**

In `src/pages/DashboardPage.tsx`:

1. Add imports near the top (after the existing `import { CATEGORIES } from '../lib/categories'`):

```ts
import { resolveCategory, type CustomCategory } from '../lib/categories'
import type { CategoryDef } from '../lib/categories'
import { useCustomCategories } from '../lib/queries'
```

2. Inside the `DashboardPage()` component, near where transactions and sales are fetched (around line 121), add:

```ts
const { data: customs = [] } = useCustomCategories()
```

3. Update the three `useMemo` calls (currently `computeKPIs(transactions, [])` etc. after Task 4):

```ts
const kpis = useMemo(() => computeKPIs(transactions, customs), [transactions, customs])
const profitability = useMemo(() => computeProfitability(sales), [sales])
const monthlyData = useMemo(() => computeMonthlyChart(transactions, customs), [transactions, customs])
const scheduleC = useMemo(() => computeScheduleC(transactions, customs), [transactions, customs])
```

- [ ] **Step 2: Merge customs into the partI/II/III filter lists**

Replace the existing block at lines ~139–150 (the `TODO(p1-custom-categories)` comment + the three `CATEGORIES.filter(...)` blocks):

```ts
const allCategories = useMemo<CategoryDef[]>(() => {
  const customsResolved = customs
    .map((c: CustomCategory) => resolveCategory(c.value, customs))
    .filter((c): c is CategoryDef => !!c)
  return [...CATEGORIES, ...customsResolved]
}, [customs])

const partI = allCategories
  .filter(c => c.scheduleLine === 'Part I'
    && scheduleC[c.value] !== undefined && scheduleC[c.value] !== 0)
  .map(c => ({ label: c.label, value: scheduleC[c.value] ?? 0 }))

const partIII = allCategories
  .filter(c => c.scheduleLine === 'Part III'
    && scheduleC[c.value] !== undefined && scheduleC[c.value] !== 0)
  .map(c => ({ label: c.label, value: Math.abs(scheduleC[c.value] ?? 0) }))

const partII = allCategories
  .filter(c => c.scheduleLine?.startsWith('Line')
    && scheduleC[c.value] !== undefined && scheduleC[c.value] !== 0)
  .map(c => ({ label: c.label, value: Math.abs(scheduleC[c.value] ?? 0), line: c.scheduleLine }))
```

(The `// TODO(p1-custom-categories)` comment is deleted with this edit — it's now done. The `// TODO(p1-returns)` comment immediately above stays; that's a separate P1 item.)

- [ ] **Step 3: Verify build + dashboard renders unchanged**

Run: `npm run build`
Expected: PASS.

Run: `npm run dev` and load the Dashboard. Expected: with no custom categories yet, the breakdown looks identical to before.

- [ ] **Step 4: Commit**

```bash
git add src/pages/DashboardPage.tsx
git commit -m "feat(custom-categories): merge customs into Dashboard Schedule C breakdown"
```

---

## Task 9: `ManageCategoriesModal`

**Files:**
- Create: `src/components/modals/ManageCategoriesModal.tsx`

- [ ] **Step 1: Build the modal**

Create `src/components/modals/ManageCategoriesModal.tsx`:

```tsx
import { useState, useMemo, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import ConfirmDialog from '../ConfirmDialog'
import CategoryBadge from '../CategoryBadge'
import { CATEGORIES, customCategoryValue, type CustomCategory } from '../../lib/categories'
import { PALETTE, PALETTE_KEYS, type ColorKey } from '../../lib/categoryPalette'
import { useCustomCategories } from '../../lib/queries'
import {
  createCustomCategory,
  updateCustomCategory,
  deleteCustomCategory,
  countTransactionsUsingCustomCategory,
} from '../../lib/mutations'

type Mode = 'list' | 'create' | { mode: 'edit'; id: string }
type Mapping = 'parent' | 'line'

// Allowed Schedule C lines for the explicit-mapping picker. Line 24b is intentionally
// excluded — users wanting a Line 24b custom must go via parent_value='meals' so the
// 50% meals deduction is inherited.
const SCHEDULE_LINES: string[] = (() => {
  const lines = new Set<string>(['Part I', 'Part III'])
  for (const c of CATEGORIES) {
    if (c.scheduleLine?.startsWith('Line ') && c.scheduleLine !== 'Line 24b') {
      lines.add(c.scheduleLine)
    }
  }
  return Array.from(lines)
})()

export default function ManageCategoriesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: customs = [] } = useCustomCategories()
  const [mode, setMode] = useState<Mode>('list')

  const active = useMemo(() => customs.filter(c => !c.deletedAt), [customs])
  const editing = useMemo(() => {
    if (typeof mode === 'object' && mode.mode === 'edit') {
      return active.find(c => c.id === mode.id) ?? null
    }
    return null
  }, [mode, active])

  function close() {
    setMode('list')
    onClose()
  }

  return (
    <Modal open={open} onClose={close} title="Manage categories">
      <div className="space-y-4">
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

            <ModalActions onCancel={close} submitLabel="Done" />
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
    </Modal>
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
  const [usageCount, setUsageCount] = useState<number | null>(null)

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

  // Live preview "fake" custom for the badge.
  const previewValue = initial?.value ?? customCategoryValue('preview-00000000-0000-0000-0000-000000000000')
  const previewCustoms: CustomCategory[] = [{
    id: 'preview', value: previewValue, name: name || 'Preview',
    colorKey, parentValue: mapping === 'parent' ? parentValue : null,
    scheduleLine: mapping === 'line' ? scheduleLine : null,
    deletedAt: null,
  }]

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
                    {SCHEDULE_LINES.map(l => <option key={l} value={l}>{l}</option>)}
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
        <CategoryBadge value={previewValue} />
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
```

- [ ] **Step 2: Verify build + open the modal from temporary trigger**

Run: `npm run build`
Expected: PASS.

For a quick smoke test before wiring permanent triggers, temporarily add a button to `ExpensesPage.tsx` near the existing "Add" button:

```tsx
<button onClick={() => setShowManage(true)} className="text-xs">Manage cats</button>
{showManage && <ManageCategoriesModal open onClose={() => setShowManage(false)} />}
```

(with `const [showManage, setShowManage] = useState(false)` and the import.) Run `npm run dev`, open the modal, create a custom category, edit it, delete it (should show "0 transactions"). Then revert the temporary button — Tasks 10–12 wire the real entry points.

- [ ] **Step 3: Commit**

```bash
git add src/components/modals/ManageCategoriesModal.tsx
git commit -m "feat(custom-categories): add ManageCategoriesModal"
```

---

## Task 10: Extract `CategoryDropdown` to its own component + add customs + Manage link

**Files:**
- Create: `src/components/CategoryDropdown.tsx`
- Modify: `src/pages/ExpensesPage.tsx`

- [ ] **Step 1: Create the shared dropdown component**

`ExpensesPage.tsx`'s inline `CategoryDropdown` (lines 52–84) is currently floating-positioned. The shared version becomes a controlled dropdown that the parent renders inline. Create `src/components/CategoryDropdown.tsx`:

```tsx
import { Settings } from 'lucide-react'
import { CATEGORIES, type CustomCategory } from '../lib/categories'
import { PALETTE } from '../lib/categoryPalette'
import { useCustomCategories, activeCustomCategories } from '../lib/queries'

interface Props {
  /** Currently selected value; for highlighting. */
  current?: string | null
  /** Called with the new value (or null for "clear"). */
  onSelect: (value: string | null) => void
  /** Called when the user clicks the "Manage categories…" footer. */
  onManage: () => void
  /** Hide the "Clear category" row (e.g. when used for an Add modal where empty=uncategorized). */
  hideClear?: boolean
}

/**
 * Three-section category picker:
 *   ─ Your categories ─    (custom, active only)
 *   ─ Schedule C ─          (built-ins, excluding the 4 isExcluded)
 *   ─ Other ─               (the 4 isExcluded built-ins)
 *   ⚙ Manage categories…    (footer)
 *
 * Caller is responsible for positioning (absolute / floating / inline).
 */
export default function CategoryDropdown({ current, onSelect, onManage, hideClear }: Props) {
  const { data: allCustoms = [] } = useCustomCategories()
  const customs = activeCustomCategories(allCustoms)

  const scheduleCBuiltIns = CATEGORIES.filter(c => !c.isExcluded)
  const excludedBuiltIns = CATEGORIES.filter(c => c.isExcluded)

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-xl py-1 overflow-y-auto max-h-72 w-64">
      {!hideClear && (
        <div
          className="px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-50 cursor-pointer"
          onClick={() => onSelect(null)}
        >
          — Clear category
        </div>
      )}

      {customs.length > 0 && (
        <>
          <SectionHeader label="Your categories" />
          {customs.map(c => {
            const swatch = PALETTE[c.colorKey]
            return (
              <Row
                key={c.value}
                color={swatch.color}
                label={c.name}
                trailing={c.parentValue
                  ? CATEGORIES.find(b => b.value === c.parentValue)?.scheduleLine
                  : c.scheduleLine}
                selected={current === c.value}
                onClick={() => onSelect(c.value)}
              />
            )
          })}
        </>
      )}

      <SectionHeader label="Schedule C" />
      {scheduleCBuiltIns.map(c => (
        <Row
          key={c.value}
          color={c.color}
          label={c.label}
          trailing={c.scheduleLine}
          selected={current === c.value}
          onClick={() => onSelect(c.value)}
        />
      ))}

      <SectionHeader label="Other" />
      {excludedBuiltIns.map(c => (
        <Row
          key={c.value}
          color={c.color}
          label={c.label}
          selected={current === c.value}
          onClick={() => onSelect(c.value)}
        />
      ))}

      <div className="border-t border-gray-100 mt-1 pt-1">
        <div
          className="px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer flex items-center gap-1.5"
          onClick={onManage}
        >
          <Settings size={12} /> Manage categories…
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
      {label}
    </div>
  )
}

function Row({
  color, label, trailing, selected, onClick,
}: {
  color: string; label: string; trailing?: string; selected?: boolean; onClick: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-gray-50 flex items-center gap-2 ${selected ? 'bg-gray-50 font-medium' : ''}`}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <span className="text-gray-700 truncate">{label}</span>
      {trailing && <span className="text-gray-400 ml-auto shrink-0">{trailing}</span>}
    </div>
  )
}
```

- [ ] **Step 2: Replace the inline CategoryDropdown in `ExpensesPage.tsx` (top-of-table dropdown)**

In `src/pages/ExpensesPage.tsx`:

1. Delete the local `CategoryDropdown` component (lines 52–84).
2. Add imports:
```ts
import CategoryDropdown from '../components/CategoryDropdown'
import ManageCategoriesModal from '../components/modals/ManageCategoriesModal'
```
3. Where the old inline `CategoryDropdown` was rendered inside the table (around line 521):
```tsx
{!tx.trade_id && ddTxId === tx.id && (
  <div
    className="fixed z-50"
    style={{ top: 'var(--dd-top)', left: 'var(--dd-left)' }}
    onMouseDown={e => e.preventDefault()}
  >
    <CategoryDropdown
      current={tx.schedule_c_category}
      onSelect={(v) => {
        // Reuse the inline updateCategory function defined earlier in the file.
        updateCategoryMutation.mutate({ id: tx.id, cat: v })
        setDdTxId(null)
      }}
      onManage={() => { setDdTxId(null); setShowManage(true) }}
    />
  </div>
)}
```
4. Add a single `updateCategoryMutation` near the top of `ExpensesPage()` so it's shared by both the table dropdown and the detail dropdown:
```ts
const updateCategoryMutation = useMutation({
  mutationFn: ({ id, cat }: { id: string; cat: string | null }) => updateCategory(id, cat),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
})
```
5. Add `const [showManage, setShowManage] = useState(false)` and render the modal once at the bottom of the page:
```tsx
<ManageCategoriesModal open={showManage} onClose={() => setShowManage(false)} />
```

- [ ] **Step 3: Replace the top-of-page category filter `<select>`**

Replace the `<select>` block around lines 443–452 with a click-to-open custom dropdown matching the rest:

```tsx
<div className="relative">
  <button
    type="button"
    onClick={() => setShowCatFilter(s => !s)}
    className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 bg-white flex items-center gap-1 min-w-[10rem]"
  >
    {catFilter
      ? (resolveCategory(catFilter, customsAll)?.label ?? catFilter)
      : 'All categories'}
    <ChevronDown size={12} className="ml-auto text-gray-400" />
  </button>
  {showCatFilter && (
    <div className="absolute right-0 top-full mt-1 z-50">
      <CategoryDropdown
        current={catFilter}
        onSelect={(v) => { setCatFilter(v); setShowCatFilter(false) }}
        onManage={() => { setShowCatFilter(false); setShowManage(true) }}
      />
    </div>
  )}
</div>
```

Add the needed state and imports:
```ts
const [showCatFilter, setShowCatFilter] = useState(false)
import { resolveCategory } from '../lib/categories'
import { useCustomCategories } from '../lib/queries'
const { data: customsAll = [] } = useCustomCategories()
```

Update the filter logic to interpret `catFilter === null` as "All" (was `''`):
```ts
// in the filter useMemo:
const matchCat = !catFilter || tx.schedule_c_category === catFilter
```

- [ ] **Step 4: Replace the inline category dropdown inside `TransactionDetail`**

In `TransactionDetail` (around lines 272–292), replace the inline list rendering with the shared component. Pass an `onManage` prop that closes the slide-over's editing-cat popover, opens the modal at the page level, and re-opens — simplest: bubble up via a prop.

Add `onManage: () => void` to `TransactionDetail`'s props; update the caller (around line 557):
```tsx
<TransactionDetail
  key={selected.id}
  tx={selected}
  onClose={() => setSelected(null)}
  onOpenTrade={(id) => { setSelected(null); setTradeId(id) }}
  onManage={() => setShowManage(true)}
/>
```
(`setEditingCat(false)` is called by the inner dropdown's onManage handler — see Step 4 — and lives inside `TransactionDetail`'s scope.)

Inside `TransactionDetail`, replace the inline `<div>…CATEGORIES.map(...)</div>` (lines ~273–292) with:
```tsx
{!tx.trade_id && editingCat && (
  <div className="absolute top-full left-0 right-0 z-10 mt-1">
    <CategoryDropdown
      current={tx.schedule_c_category}
      onSelect={(v) => { catMutation.mutate(v); setEditingCat(false) }}
      onManage={() => { setEditingCat(false); onManage() }}
    />
  </div>
)}
```

- [ ] **Step 5: Verify build + manual smoke test**

Run: `npm run build`
Expected: PASS.

Run: `npm run dev`. On the Expenses page:
1. Open the top filter dropdown → see "Your categories" (empty initially), "Schedule C", "Other", "Manage categories…" footer.
2. Click "Manage categories…" → modal opens.
3. Create "Stripe Fees" with parent=commissions_fees. Save.
4. Re-open the top filter → "Stripe Fees" appears under "Your categories".
5. Click on a transaction's category cell to open the inline dropdown → same sections appear.
6. Assign "Stripe Fees" to a transaction → badge renders with the chosen color.
7. Open the detail pane → category dropdown there also shows "Stripe Fees" and the Manage footer.

- [ ] **Step 6: Commit**

```bash
git add src/components/CategoryDropdown.tsx src/pages/ExpensesPage.tsx
git commit -m "feat(custom-categories): wire CategoryDropdown + Manage into Expenses page"
```

---

## Task 11: `AddTransactionModal` dropdown conversion

**Files:**
- Modify: `src/components/modals/AddTransactionModal.tsx`

- [ ] **Step 1: Replace the `<select>` with the shared dropdown**

In `src/components/modals/AddTransactionModal.tsx`:

1. Replace the `import { CATEGORIES } from '../../lib/categories'` line with imports for the new components:
```ts
import { useState, type FormEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { resolveCategory } from '../../lib/categories'
import { useCustomCategories } from '../../lib/queries'
import CategoryDropdown from '../CategoryDropdown'
import ManageCategoriesModal from './ManageCategoriesModal'
```

2. Add state for the popover + manage modal at the top of the component:
```ts
const [catOpen, setCatOpen] = useState(false)
const [showManage, setShowManage] = useState(false)
const { data: customs = [] } = useCustomCategories()
```

3. Replace the `<Field label="Schedule C Category">…</Field>` block (lines 88–97) with:
```tsx
<Field label="Schedule C Category">
  <div className="relative">
    <button
      type="button"
      onClick={() => setCatOpen(o => !o)}
      className={inputCls + ' bg-white flex items-center text-left'}
    >
      <span className={category ? 'text-gray-900' : 'text-gray-400'}>
        {category
          ? (resolveCategory(category, customs)?.label ?? category)
          : '— Uncategorized'}
      </span>
      <ChevronDown size={12} className="ml-auto text-gray-400" />
    </button>
    {catOpen && (
      <div className="absolute left-0 right-0 top-full z-20 mt-1">
        <CategoryDropdown
          current={category || null}
          onSelect={(v) => { setCategory(v ?? ''); setCatOpen(false) }}
          onManage={() => { setCatOpen(false); setShowManage(true) }}
        />
      </div>
    )}
  </div>
</Field>
```

4. Render the modal at the bottom of the form (before the closing `</Modal>`):
```tsx
<ManageCategoriesModal open={showManage} onClose={() => setShowManage(false)} />
```

- [ ] **Step 2: Verify build + manual test**

Run: `npm run build`
Expected: PASS.

Run: `npm run dev`. From the Expenses page click "Add" → AddTransactionModal opens. The category picker:
1. Shows the three sections including "Stripe Fees" (created in Task 10's smoke test).
2. "Manage categories…" footer opens the manage modal nested inside Add Transaction.
3. Creating a new custom category from the nested modal returns to the Add Transaction flow and the new one is selectable.

- [ ] **Step 3: Commit**

```bash
git add src/components/modals/AddTransactionModal.tsx
git commit -m "feat(custom-categories): AddTransactionModal uses shared CategoryDropdown"
```

---

## Task 12: Documentation updates

**Files:**
- Modify: `docs/supabase-schema.md`, `docs/categories.md`, `docs/features/expenses.md`, `TASKS.md`

- [ ] **Step 1: `docs/supabase-schema.md`**

1. Find the bullet `- custom_categories (planned — user-defined Schedule C categories, web-only improvement over mobile's UserDefaults approach)` under "Tables referenced but not yet built on" — delete it.

2. Insert a new `### custom_categories` section right after the `### trades` section (and before the "Tables referenced but not yet built on" subhead):

```markdown
### `custom_categories`
Per-user, tax-aware Schedule C categories. See [`docs/superpowers/specs/2026-06-25-custom-categories-design.md`](superpowers/specs/2026-06-25-custom-categories-design.md) for the full design.

| column | notes |
|---|---|
| `id`, `user_id`, `created_at`, `deleted_at` | soft-deleted; tombstoned rows are still SELECT-able so transactions referencing them resolve correctly |
| `name` | display label, ≤ 40 chars, soft-uniqueness scoped to the user's active rows |
| `color_key` | references one of 12 swatches in [`src/lib/categoryPalette.ts`](../src/lib/categoryPalette.ts) (e.g. `'rose'`, `'emerald'`) |
| `parent_value` | nullable text; when set, points to a built-in `CATEGORIES[].value` (e.g. `'commissions_fees'`). Inherits `scheduleLine`/`mealsHalf`/`isExcluded` from the parent at resolution time |
| `schedule_line` | nullable text; mutually exclusive with `parent_value`. Allowed values: `'Part I' \| 'Part III' \| 'Line 8'…'Line 30'` excluding `'Line 24b'` (Line 24b must go via `parent_value = 'meals'` so the 50% deduction is inherited) |

**CHECK:** `(parent_value IS NOT NULL) <> (schedule_line IS NOT NULL)` — exactly one of `parent_value` / `schedule_line` is non-null.

`transactions.schedule_c_category` stores `cust_<uuid-no-hyphens>` for rows tagged with a custom category. No schema change to `transactions`.
```

- [ ] **Step 2: `docs/categories.md`**

1. Replace the "Custom categories (planned — P1)" section with the shipped design:

```markdown
## Custom categories (shipped 2026-06-25)

Stored in the `custom_categories` table (see [`docs/supabase-schema.md`](supabase-schema.md)). Two modes, mutually exclusive (CHECK constraint at the DB):

- **`parent_value`** set: the custom is a refinement of a built-in. It inherits `scheduleLine` / `mealsHalf` / `isExcluded` from the parent. E.g. `"Stripe Fees"` with `parent_value = 'commissions_fees'` lands in Line 10.
- **`schedule_line`** set: the custom maps directly to a Schedule C line (`'Part I' | 'Part III' | 'Line 8'…'Line 30'`, **excluding `'Line 24b'`** — Line 24b requires the 50% meals deduction, which is only inherited via `parent_value = 'meals'`).

Resolution lives in `resolveCategory(value, customs)` in [`src/lib/categories.ts`](../src/lib/categories.ts). All code paths that touch real transaction data (`bucketTransaction`, the Dashboard `partI`/`partII`/`partIII` filter builders, `CategoryBadge`) call `resolveCategory` instead of `getCategoryDef`. `getCategoryDef` is kept for pure-built-in picker swatch loops.

**Soft delete:** deleting a custom sets `deleted_at`. Historical transactions referencing the tombstone keep working — `resolveCategory` still returns the resolved def with `" (deleted)"` appended to the label. Pickers filter `!deletedAt` via `activeCustomCategories()`. Restoring deleted customs from a "Recently deleted" view is a v2 follow-up.

**On-the-wire value:** `transactions.schedule_c_category` stores `cust_<uuid-no-hyphens>` for custom rows. The `cust_` prefix avoids collision with future built-in slugs.

**Management UI:** `ManageCategoriesModal`, reachable via the "⚙ Manage categories…" footer in every category-picker dropdown (Expenses filter, Expenses inline category cell, transaction detail-pane category, AddTransactionModal). No dedicated Settings page.
```

2. Update the "Known correctness gaps" section: remove the custom-categories bullet.

- [ ] **Step 3: `docs/features/expenses.md`**

Locate the section describing the category picker (or add a "Custom categories" subsection if missing). Add:

```markdown
### Custom categories

Every category picker (top-of-page filter, inline category cell, detail-pane dropdown, and AddTransactionModal) groups options into:

- **Your categories** — user-defined customs (active only)
- **Schedule C** — built-in non-excluded categories
- **Other** — excluded built-ins (Transfer, Personal, Settlement, Balance Adjustment)
- **⚙ Manage categories…** footer — opens `ManageCategoriesModal` for CRUD

Deleted custom categories don't appear in pickers but historical transactions tagged with them still render as `"Name (deleted)"` and continue to roll up to their `scheduleLine` in the Dashboard Schedule C breakdown.
```

- [ ] **Step 4: `TASKS.md`**

1. In the P1 "Categorization" section, strike the "Custom Schedule C categories" item with the shipping commit ref (use the actual hash from `git log -1` after Task 11):

```markdown
- [x] **Custom Schedule C categories** — Shipped 2026-06-25 (see `docs/superpowers/specs/2026-06-25-custom-categories-design.md`). Supabase-backed (`custom_categories` table) with hybrid tax-mapping (parent_value or explicit schedule_line). _Closed by <commit-hash>._
```

2. In the P0 section, strike guardrail #3 with the same ref:

```markdown
- [x] **Custom categories must appear in Schedule C breakdown from day one** — `resolveCategory` + `DashboardPage` merged `allCategories` list deliver this. _Closed by <commit-hash>._
```

- [ ] **Step 5: Verify docs build + commit**

Re-read each modified doc once for typos / link integrity. Run:
```bash
npm run build
```
Expected: PASS (no code change, but checks `docs/` link references compile if any TSX imports them).

```bash
git add docs/supabase-schema.md docs/categories.md docs/features/expenses.md TASKS.md
git commit -m "docs(custom-categories): document shipped feature + strike P0/P1 items"
```

---

## Task 13: End-to-end manual verification

**Files:** none

- [ ] **Step 1: Run a full smoke scenario in dev**

Start dev: `npm run dev`.

Walk through each scenario from the spec's "Success criteria" section. Take notes; any failure → file an issue and re-run the affected task.

1. **Stripe Fees / parent-mode flow:**
   - Open Expenses → category filter dropdown → "Manage categories…"
   - Create custom: name `Stripe Fees`, color `rose`, mapping = "Refine an existing", parent = `Commissions & Fees`. Save.
   - Open a non-trade transaction's category cell → assign `Stripe Fees`. Badge renders with rose colors.
   - Dashboard → Schedule C breakdown shows `Stripe Fees` as its own row under Line 10. The Line 10 total = built-in `commissions_fees` total + `cust_…` total.

2. **Reseller Subscription / explicit-line flow:**
   - Manage categories → New: name `Reseller Subscription`, color `sky`, mapping = "Map to a Schedule C line directly", line = `Line 25`. Save.
   - Assign to a transaction. Verify Dashboard breakdown groups it under Line 25 alongside built-in `utilities`.

3. **Excluded inheritance:**
   - Create a custom with `parent_value = 'personal'` (e.g. `Family Reimbursement`). Assign to a transaction. Verify it does NOT appear in KPI totals, monthly chart, or Schedule C breakdown.

4. **Tombstone:**
   - Delete `Stripe Fees`. Confirmation dialog reports the correct usage count. After delete:
     - Pickers no longer show `Stripe Fees`.
     - Transactions previously tagged still render `Stripe Fees (deleted)`.
     - Line 10 total still includes those dollars.

5. **Validation:**
   - Try creating two customs with the same name → second one rejected ("already exists").
   - Try a 41-char name → rejected.
   - Try `Line 24b` in the explicit-line dropdown → it's not an option in the `<select>`.
   - Try Part III explicit-line → soft warning renders, save still works.

6. **AddTransactionModal:**
   - Click "Add" on Expenses. The category picker includes the active customs; manage from nested modal works.

7. **Existing built-in flow:**
   - Categorize a transaction with `Advertising`. Verify badge, breakdown row, totals all match pre-feature behavior.

- [ ] **Step 2: Run lint + build one last time**

```bash
npm run lint && npm run build
```
Expected: PASS.

- [ ] **Step 3: No commit (this task changes nothing)**

If issues were found and code was patched, those went into earlier tasks' commits. This task is purely verification.

---

## Notes for the executor

- **TDD is intentionally skipped.** Per `CLAUDE.md`: "No test suite exists — don't add tests unless explicitly asked." Verification is build + lint + manual.
- **Commits per task.** Each task ends with a single conventional commit. Don't squash across tasks.
- **No `--no-verify`.** If a pre-commit hook fails, fix the underlying issue.
- **Schema migration first.** Don't start Task 5 (queries) before Task 1 succeeds — the hook will hit a missing table otherwise.
- **Hook subscription cost.** `useCustomCategories` is called by `CategoryBadge`, `CategoryDropdown`, every page that mounts these. React Query dedupes by `queryKey: ['custom_categories']` so it's one fetch per refetch cycle, not one per badge. If profiling later shows pressure, hoist to a React context — out of scope for v1.
- **Mobile parity.** The iOS app is not touched. Schema is additive; iOS reads nothing from `custom_categories`.
