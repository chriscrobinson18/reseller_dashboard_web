# Custom Schedule C Categories

**Status:** Draft — awaiting user review
**Date:** 2026-06-25
**Author:** Brainstormed with Claude

## Background

Mobile has a `CustomCategoryStore` that's UserDefaults-only — device-local, not cross-device, no tax-classification metadata (just name/icon/color). The web app is the new primary client; this spec ships custom categories as a Supabase-backed, tax-aware feature from day one rather than porting the mobile gap forward.

The P0 tax-correctness pass (`docs/superpowers/specs/2026-06-23-p0-tax-correctness-design.md`) explicitly called out item #3: when custom categories ship, `computeScheduleC` must include them or all custom-categorized transactions silently disappear from the breakdown. `bucketTransaction` is already category-string-agnostic (no `CATEGORIES.find` dependency) — the work is in the render layer and the dropdown pickers.

## Design constraints

- **Tax-classification-first.** A custom category must roll up to a real Schedule C line (or explicitly inherit `isExcluded` from a built-in). No pure visual tags — they'd violate the P0 guardrail.
- **Two modes, mutually exclusive.** Either a custom is a **refinement of a built-in** (inherits `scheduleLine`/`mealsHalf`/`isExcluded`) or it **explicitly picks a Schedule C line**.
- **Web-only feature.** iOS keeps its UserDefaults store until separately ported; the schema is additive and the iOS app reads no rows from `custom_categories`.
- **No Settings page dependency.** Management lives inline from the Expenses category dropdowns. The Settings page is a separate P1 item.
- **Soft-delete with tombstone resolution.** Existing transactions keep their `cust_<uuid>` reference and render with `(deleted)` suffix; tax math still rolls up correctly via the resolved `scheduleLine`.

## Data model

### New table: `custom_categories`

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid | RLS-scoped (mirrors `items` policy) |
| `created_at` | timestamptz | |
| `deleted_at` | timestamptz | nullable; soft-delete with tombstone display |
| `name` | text NOT NULL | display label, e.g. `"Stripe Fees"`; ≤ 40 chars; unique among the user's `deleted_at IS NULL` rows |
| `color_key` | text NOT NULL | references a fixed palette (~12 swatches) in `src/lib/categoryPalette.ts`; e.g. `'rose'`, `'sky'`, `'emerald'` |
| `parent_value` | text NULL | if set, points to a built-in `CATEGORIES[].value` (e.g. `'commissions_fees'`); inherits `scheduleLine`/`mealsHalf`/`isExcluded` at resolution time |
| `schedule_line` | text NULL | mutually exclusive with `parent_value`; one of `'Part I' \| 'Part III' \| 'Line 8' … 'Line 30'` (excluded categories are reached via `parent_value`) |

**CHECK constraint:** `(parent_value IS NOT NULL) <> (schedule_line IS NOT NULL)` — exactly one is non-null.

**Why no `is_excluded` / `meals_half` columns:**
- `is_excluded`: if the user wants an excluded custom (e.g. "Family Transfer"), they set `parent_value = 'personal'` (or `transfer` / `settlement` / `balance_adjustment`) and inherit the flag. Simpler invariant.
- `meals_half`: the only Schedule C line where this applies is Line 24b. A custom there would be `parent_value = 'meals'` and inherits the half-deduction. No need to expose the boolean.

### `transactions.schedule_c_category` — no schema change

Existing free-text column accepts either a built-in slug (e.g. `'office_expense'`) or a custom-category value of the form `cust_<uuid-no-hyphens>`. The `cust_` prefix:
- Avoids any future collision with a built-in slug
- Makes raw DB inspection obvious ("this row's category is user-defined")

Construction: `` `cust_${id.replace(/-/g, '')}` `` (client-side; not stored on the row).

## Resolution layer (`src/lib/categories.ts`)

### New file: `src/lib/categoryPalette.ts`

```ts
export type ColorKey = 'emerald' | 'sky' | 'rose' | 'amber' | 'violet' | 'slate'
  | 'orange' | 'teal' | 'indigo' | 'pink' | 'lime' | 'cyan'

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
```

### Type addition

```ts
export interface CustomCategory {
  id: string
  value: string            // 'cust_<uuid-no-hyphens>'
  name: string
  colorKey: ColorKey
  parentValue: string | null
  scheduleLine: string | null
  deletedAt: string | null
}
```

`CategoryDef` is unchanged. A new `ResolvedCategoryDef` is the same shape as `CategoryDef` (returned by `resolveCategory` so downstream code doesn't branch on built-in vs. custom).

### `resolveCategory(value, customs)`

Replaces `getCategoryDef` in every code path that touches real transaction data (bucketing, dashboard rendering, badges, dropdown rendering).

```ts
export function resolveCategory(
  value: string | null | undefined,
  customs: CustomCategory[],
): CategoryDef | undefined {
  if (!value) return undefined

  const builtIn = CATEGORIES.find(c => c.value === value)
  if (builtIn) return builtIn

  // includes tombstoned customs — resolution must still succeed for display + bucketing
  const custom = customs.find(c => c.value === value)
  if (!custom) return undefined

  const swatch = PALETTE[custom.colorKey]
  const labelSuffix = custom.deletedAt ? ' (deleted)' : ''

  if (custom.parentValue) {
    const parent = CATEGORIES.find(c => c.value === custom.parentValue)
    if (!parent) return undefined  // referential gap — treated as uncategorized
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

`getCategoryDef` is kept (called by pure-built-in render paths like the Expenses filter dropdown's color swatch loop), but anything that aggregates real money routes through `resolveCategory`.

### `bucketTransaction(t, customs)` — signature change

```ts
export function bucketTransaction(t: Transaction, customs: CustomCategory[]): BucketedAmount {
  // ...existing early-return checks unchanged...
  const cat = resolveCategory(t.schedule_c_category, customs)  // was: getCategoryDef(...)
  // ...rest unchanged — Part I → income, Part III → cogs, otherwise expense...
}
```

All three Dashboard aggregates (`computeKPIs`, `computeMonthlyChart`, `computeScheduleC`) gain a `customs: CustomCategory[]` parameter and forward it.

## Queries & mutations

### New hook: `useCustomCategories()` (`src/lib/queries.ts`)

```ts
export function useCustomCategories() {
  return useQuery({
    queryKey: ['custom_categories'],
    queryFn: async (): Promise<CustomCategory[]> => {
      // intentional: no .is('deleted_at', null) — tombstoned rows are needed
      // for resolution (badge display + Schedule C bucketing of historical txns).
      // Pickers filter !deletedAt client-side.
      const { data, error } = await supabase
        .from('custom_categories')
        .select('id, name, color_key, parent_value, schedule_line, deleted_at')
        .order('name')
      if (error) throw error
      return (data ?? []).map(r => ({
        id: r.id,
        value: `cust_${r.id.replace(/-/g, '')}`,
        name: r.name,
        colorKey: r.color_key as ColorKey,
        parentValue: r.parent_value,
        scheduleLine: r.schedule_line,
        deletedAt: r.deleted_at,
      }))
    },
  })
}
```

Selectors (not separate hooks — same query, filtered):

```ts
export function activeCustomCategories(customs: CustomCategory[]): CustomCategory[] {
  return customs.filter(c => !c.deletedAt)
}
```

### New mutations (`src/lib/mutations.ts`)

```ts
createCustomCategory(params: {
  name: string
  colorKey: ColorKey
  parentValue: string | null      // exactly one of parentValue/scheduleLine non-null
  scheduleLine: string | null
}): Promise<string>                // returns new id

updateCustomCategory(id: string, params: {
  name?: string
  colorKey?: ColorKey
  parentValue?: string | null
  scheduleLine?: string | null
}): Promise<void>

deleteCustomCategory(id: string): Promise<void>  // sets deleted_at
```

**Validation (client-side; DB CHECK is the backstop):**
- `name` non-empty, trimmed, ≤ 40 chars
- `colorKey` ∈ `PALETTE_KEYS`
- Exactly one of `parentValue` / `scheduleLine` non-null
- If `parentValue` set: must equal some `CATEGORIES[].value`
- If `scheduleLine` set: must equal `'Part I' | 'Part III'` or some `CATEGORIES[].scheduleLine` that starts with `'Line '`, **excluding `'Line 24b'`** (see UI section — Line 24b is forced through `parent_value = 'meals'` so the 50% deduction is inherited and can't be silently dropped)
- Name uniqueness scoped to the user's active (`!deleted_at`) rows — soft block; not a DB unique index because that would fight tombstones

**Cache invalidation:**
- `create` / `update` / `delete` all invalidate `['custom_categories']`
- `delete` additionally invalidates `['transactions']` so badges re-render with the `(deleted)` suffix

## UI

### Entry point: Expenses category dropdowns

Three dropdowns gain a `─ ⚙ Manage categories… ─` row at the bottom:

1. **`ExpensesPage.tsx`** — top-of-page category filter dropdown (around line 71). Today a native `<select>`; convert to a custom dropdown matching the existing inline `CategoryDropdown` so the link row fits.
2. **`ExpensesPage.tsx`** — `CategoryDropdown` inline component (around line 280) used by the detail pane.
3. **`AddTransactionModal.tsx`** — category `<select>` (around line 91). Convert to the same custom dropdown.

All three open `<ManageCategoriesModal />`.

### `ManageCategoriesModal` (`src/components/modals/ManageCategoriesModal.tsx`)

Uses the existing `Modal` primitive. Single screen with an inline create/edit form (no nested overlay).

```
┌─ Manage categories ──────────────────────────────┐
│  [ + New category ]                              │
│                                                  │
│  ── Your categories ──                           │
│   ● Stripe Fees             Line 10              │
│        parent: Commissions & Fees          ✏ 🗑 │
│   ● Customer Meals          Line 24b             │
│        parent: Meals (50%)                 ✏ 🗑 │
│   ● Reseller Subscription   Line 25              │
│        (custom mapping)                    ✏ 🗑 │
│                                                  │
│  ── Built-in (read-only) ──                      │
│   ● Payout / Income         Part I               │
│   ● Cost of Goods           Part III             │
│   …                                              │
└──────────────────────────────────────────────────┘
```

**Empty state:** "No custom categories yet. Click + New category to create one for things like Stripe Fees, customer meals, or any line item that isn't in the built-in list."

**Create / Edit form** (expands inline at the top of the modal when triggered):

- **Name** — text input, 40-char max, live counter
- **Color** — 12-swatch grid (3 rows × 4); click to select; selected ring on hover/focus
- **Tax mapping** — radio group:
  - ◯ **Refine an existing category** — when selected, shows a `<select>` of all built-ins (label + scheduleLine annotation, same dropdown style as `CategoryDropdown`). Inherits `scheduleLine`/`mealsHalf`/`isExcluded`.
  - ◯ **Map to a Schedule C line directly** — when selected, shows a `<select>` of `'Part I' | 'Part III' | 'Line 8' … 'Line 30'`, **excluding `'Line 24b'`** (Line 24b requires the 50% meals deduction; force the user through `parent_value = 'meals'` instead so `mealsHalf` is inherited). Soft warning if `Part III` is picked: "Part III is for inventory cost — most users won't need a custom there. Continue?"
- **Live preview** — a `CategoryBadge` next to the form rendering the in-progress name + color
- **Save / Cancel** buttons
- **Delete** button on the edit form → `ConfirmDialog`:
  - If N > 0 transactions reference it (looked up via a one-off `select count(*) from transactions where schedule_c_category = 'cust_…'`): `"N transactions use this category. They'll keep showing the '(deleted)' badge until you recategorize them."`
  - If N = 0: `"Delete this category?"`

### Picker integration

`CategoryDropdown` (and the equivalent in `AddTransactionModal`) renders sections:

```
─ Your categories ─
  ● Stripe Fees                          Line 10
  ● Customer Meals                       Line 24b
─ Schedule C ─
  ● Payout / Income                      Part I
  ● Returns & Allowances                 Part I
  ● Cost of Goods                        Part III
  ● Advertising                          Line 8
  …
─ Other ─
  ● Transfer
  ● Personal
  ● Settlement
  ● Balance Adjustment
─────────────────────────────────────────────────
  ⚙ Manage categories…
```

The detail-pane dropdown gets the "Manage" footer too so the user can jump straight from a categorize action.

### Badge rendering

`CategoryBadge` internally calls `useCustomCategories()` and routes through `resolveCategory(value, customs)`. One extra hook subscription per badge is fine (React Query dedupes by `queryKey`). If perf is a measurable concern after profiling, hoist into a React context — out of scope for v1.

Tombstoned customs render with `(deleted)` suffix in the label via `resolveCategory`'s logic — no badge-component changes.

## Aggregate function changes (`src/pages/DashboardPage.tsx`)

1. `useCustomCategories()` at the top of the page; pass `customs` to all three aggregates.
2. `computeKPIs(transactions, customs)`, `computeMonthlyChart(transactions, customs)`, `computeScheduleC(transactions, customs)` — each forwards to `bucketTransaction(t, customs)`.
3. Replace the `partI` / `partII` / `partIII` filter blocks (currently `CATEGORIES.filter(...)`):

```ts
const allCategories = useMemo(() => {
  const customsResolved = customs
    .map(c => resolveCategory(c.value, customs))
    .filter((c): c is CategoryDef => !!c)
  return [...CATEGORIES, ...customsResolved]
}, [customs])

const partI = allCategories
  .filter(c => c.scheduleLine === 'Part I' && (scheduleC[c.value] ?? 0) !== 0)
  .map(c => ({ label: c.label, value: scheduleC[c.value] ?? 0 }))
// partII / partIII analogous
```

4. Tombstoned customs that have non-zero `scheduleC[value]` in the period **are** included in the breakdown (the dollars are real for tax). The `(deleted)` suffix in the label tells the user.

5. Remove the inline `// TODO(p1-custom-categories): …` markers at line 139 once the merge logic ships.

## Edge cases

- **Tombstoned custom referenced by a transaction:** badge shows `"Stripe Fees (deleted)"`; transaction still counts toward Schedule C totals via the resolved `scheduleLine`; user can recategorize from the Expenses detail pane (active pickers hide the tombstone, so the user can only switch *to* something else).
- **`parent_value` points to a built-in slug that doesn't exist** (future built-in removal): `resolveCategory` returns `undefined` → badge falls back to neutral gray "—" + raw value; bucketing returns `null` (silently drops out of Schedule C, same as uncategorized). Acceptable: no built-in is currently scheduled for removal, and the migration risk is one-time.
- **Name collision with a built-in label** (user names a custom `"Office Expense"`): allowed. Stored values differ (`cust_…` vs `office_expense`); no aggregation collision. UI is slightly confusing — accept; uniqueness check is only across the user's own active customs.
- **Custom under Part I:** allowed (e.g. `"Tournament Winnings"` → Part I). Same bucketing path as `payout`.
- **Custom under Part III:** allowed with a soft form-time warning. Part III is reserved for inventory cost; a custom COGS sub-type risks obscuring lot-linked accounting. Not blocked — power users may genuinely want it.
- **Mid-period creation:** existing transactions don't get retroactively recategorized. User recategorizes one-by-one (or via the future "Bulk categorize" P1 item).
- **Concurrent edit/delete from two tabs:** standard last-write-wins via PATCH. React Query refetch on focus catches the staleness on the loser's side. Not a real risk in practice.

## Out of scope (v1)

- `meals_half` override on customs (covered by `parent_value = 'meals'`)
- Bulk recategorize tool (separate P1: "Bulk categorize")
- Auto-categorization rules driven by custom categories (separate P1: `category_rules` table)
- iOS UI parity — iOS keeps its UserDefaults store until separately ported
- CSV export support — deferred to the P1 "CSV export" spec, which must aggregate customs into their resolved `scheduleLine` for the IRS form view and emit a separate-row label for the transaction dump
- Settings page shell — separate P1
- Icons on custom categories — color-only v1
- Free-hex color picker — fixed palette only
- Reordering / pinning customs in pickers — always alpha-sorted
- Restore-from-tombstone affordance in Manage Categories — v1 hides tombstones; v2 can add a "Recently deleted" section with restore
- Custom categories under Line 24b without `parent_value = 'meals'` — Line 24b is excluded from the explicit-scheduleLine picker to prevent silent loss of the 50% deduction
- Custom categories on the iOS app — schema is additive; iOS reads nothing from this table

## Documentation updates (same PR)

Per `CLAUDE.md` doc-maintenance rule:

- **`docs/supabase-schema.md`** — promote `custom_categories` from the "Tables referenced but not yet built on" list into the main table section; document the CHECK constraint and RLS policy.
- **`docs/categories.md`** — replace the "Custom categories (planned — P1)" section with the shipped design (resolution path, parent_value vs schedule_line modes, tombstone semantics). Update the "Known correctness gaps" section to strike the custom-categories bullet.
- **`docs/features/expenses.md`** (and `dashboard.md` if it exists; otherwise extend the relevant feature doc) — document the Manage Categories modal entry point, the picker section grouping, and the breakdown changes.
- **`TASKS.md`** — strike the P1 "Custom Schedule C categories" item with the shipping commit ref; strike the P0 guardrail #3 ("Custom categories must appear in Schedule C breakdown from day one") with the same ref.

## Resolved design decisions (from brainstorm)

1. **Tax model:** hybrid — exactly one of `parent_value` (inherit from a built-in) or `schedule_line` (explicit Schedule C line) is non-null. No standalone `is_excluded` / `meals_half` columns.
2. **Management UI:** inline from the Expenses category dropdowns (no Settings page dependency).
3. **Delete behavior:** soft-delete with tombstone display (`(deleted)` suffix); Schedule C math keeps rolling up via the resolved `scheduleLine`.
4. **Visual metadata:** color from a fixed ~12-swatch palette; no icons, no free-hex.
5. **Resolution location:** client-side (`useCustomCategories()` hook + `resolveCategory()` helper), not a server-side merged view.

## Success criteria

- User creates `"Stripe Fees"` with `parent_value = 'commissions_fees'`. It appears in the Expenses category dropdown, is assignable to a transaction, and shows in the Dashboard Schedule C breakdown as a named sub-row under Line 10. The Line 10 total includes both built-in `commissions_fees` and `cust_stripe_fees` transactions.
- User creates `"Reseller Subscription"` with `schedule_line = 'Line 25'`; it appears under Utilities on the breakdown; the Line 25 total sums via `bucketTransaction`.
- User creates a custom with `parent_value = 'personal'`; transactions tagged with it are excluded from every Schedule C aggregate (KPI, monthly chart, breakdown).
- User soft-deletes a custom that has 3 transactions referencing it: badges render `"Stripe Fees (deleted)"`; transactions still bucket correctly into Line 10; the deleted custom is hidden from all active pickers **and from the Manage Categories modal** (the user can find the tombstone via the badge on any tagged transaction; a "Recently deleted" / restore affordance is deferred to v2).
- Hand-tally of a sample period including both built-in and custom-categorized transactions matches `computeScheduleC`'s output.
- All `docs/` updates above ship in the same PR.

## Migration / rollout

- Single migration: `create table custom_categories (…)` with CHECK + RLS policies mirroring `items`.
- No backfill needed — opt-in feature; existing built-in categorization is unchanged.
- No edge function — all CRUD goes through the JS client + RLS.
- Deploy order: migration → web build. iOS unchanged.
