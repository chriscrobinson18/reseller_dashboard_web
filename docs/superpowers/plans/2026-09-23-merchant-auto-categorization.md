# Merchant Auto-Categorization Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build merchant auto-categorization rules end-to-end: schema, backfill RPC, TypeScript types, query hook, mutations, transaction detail rule hint UI, Settings management section, and `plaid_sync_transactions` v35 applying rules at sync time.

**Architecture:** Rules live in `category_rules` (one row per user × Plaid `merchant_entity_id`). At sync time, `plaid_sync_transactions` looks up rules for the batch's entity IDs and stamps `schedule_c_category` on null rows _before_ the PFC fallback, so user rules take precedence over Plaid's generic category inference. Existing uncategorized rows are covered by a `apply_category_rules` Postgres RPC triggered from a Settings "Apply Rules Now" button. Rules are created with one click from the transaction detail panel.

**Tech Stack:** Supabase (Postgres migration + RPC + RLS), TypeScript/React 19, TanStack React Query v5, Tailwind v4, Deno (edge function)

---

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20260923120000_category_rules.sql` | Create — table, index, RLS, `apply_category_rules` function |
| `src/lib/types.ts` | Modify — add `CategoryRule` interface |
| `src/lib/queries.ts` | Modify — add `useCategoryRules()` hook |
| `src/lib/mutations.ts` | Modify — add `createOrUpdateCategoryRule`, `deleteCategoryRule`, `applyAllCategoryRules` |
| `src/pages/ExpensesPage.tsx` | Modify — rule hint row in `TransactionDetail` component |
| `src/pages/SettingsPage.tsx` | Modify — `CategoryRulesSection` component + insert into categories tab |
| `supabase/functions/plaid_sync_transactions/index.ts` | Modify — v35: apply rules before PFC fallback |

---

### Task 1: Migration — `category_rules` table + `apply_category_rules` RPC

**Files:**
- Create: `supabase/migrations/20260923120000_category_rules.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- category_rules: one rule per user per Plaid merchant_entity_id.
-- apply_category_rules(uuid): stamps null schedule_c_category on matching rows.
create table public.category_rules (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  merchant_entity_id  text not null,
  merchant_name       text not null,
  schedule_c_category text not null,
  created_at          timestamptz not null default now(),
  unique (user_id, merchant_entity_id)
);

create index on public.category_rules (user_id, merchant_entity_id);

alter table public.category_rules enable row level security;

create policy "Users can read own rules"
  on public.category_rules for select
  using (user_id = auth.uid());

create policy "Users can insert own rules"
  on public.category_rules for insert
  with check (user_id = auth.uid());

create policy "Users can update own rules"
  on public.category_rules for update
  using (user_id = auth.uid());

create policy "Users can delete own rules"
  on public.category_rules for delete
  using (user_id = auth.uid());

create or replace function public.apply_category_rules(p_user_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  with updated as (
    update transactions t
    set schedule_c_category = r.schedule_c_category
    from category_rules r
    where t.user_id = p_user_id
      and r.user_id = p_user_id
      and t.merchant_entity_id = r.merchant_entity_id
      and t.schedule_c_category is null
    returning t.id
  )
  select count(*)::integer from updated;
$$;

grant execute on function public.apply_category_rules(uuid) to authenticated;
```

- [ ] **Step 2: Apply migration via Supabase MCP `apply_migration`**

Name: `category_rules` — paste the SQL above.

- [ ] **Step 3: Verify the table and function exist**

Run via MCP `execute_sql`:
```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'category_rules'
order by ordinal_position;
```
Expected columns: `id`, `user_id`, `merchant_entity_id`, `merchant_name`, `schedule_c_category`, `created_at`.

Also verify the function:
```sql
select proname from pg_proc where proname = 'apply_category_rules';
```
Expected: one row.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260923120000_category_rules.sql
git commit -m "feat: add category_rules table and apply_category_rules RPC"
```

---

### Task 2: `CategoryRule` type + `useCategoryRules` query hook

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/queries.ts`

- [ ] **Step 1: Add `CategoryRule` interface to `src/lib/types.ts`**

Append after the last interface definition in the file:

```typescript
export interface CategoryRule {
  id: string
  user_id: string
  merchant_entity_id: string
  merchant_name: string
  schedule_c_category: string
  created_at: string
}
```

- [ ] **Step 2: Add `CategoryRule` to the type import in `src/lib/queries.ts` (line 3)**

Current line 3:
```typescript
import type { Item, InventoryLot, Trade, SaleBundle, PlaidItem, PlaidAccount, Transaction, BoxOpening, CSVGroup } from './types'
```

Replace with:
```typescript
import type { Item, InventoryLot, Trade, SaleBundle, PlaidItem, PlaidAccount, Transaction, BoxOpening, CSVGroup, CategoryRule } from './types'
```

- [ ] **Step 3: Add `useCategoryRules` hook at the end of `src/lib/queries.ts`**

```typescript
/** All auto-categorization rules for the current user, ordered by merchant name. */
export function useCategoryRules() {
  return useQuery({
    queryKey: ['category_rules'],
    queryFn: async (): Promise<CategoryRule[]> => {
      const { data, error } = await supabase
        .from('category_rules')
        .select('*')
        .order('merchant_name')
      if (error) throw error
      return (data ?? []) as CategoryRule[]
    },
  })
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build
```

Expected: zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/queries.ts
git commit -m "feat: add CategoryRule type and useCategoryRules query hook"
```

---

### Task 3: Category rule mutations

**Files:**
- Modify: `src/lib/mutations.ts`

- [ ] **Step 1: Append the three mutation functions at the end of `src/lib/mutations.ts`**

```typescript
// ─── Category Rules ───────────────────────────────────────────────────────────

/**
 * Creates or updates a category rule for a Plaid merchant entity.
 * Upsert on (user_id, merchant_entity_id) — safe to call repeatedly for the
 * same merchant as the user changes the category assignment.
 */
export async function createOrUpdateCategoryRule(params: {
  merchant_entity_id: string
  merchant_name: string
  schedule_c_category: string
}): Promise<void> {
  const user_id = await getUserId()
  const { error } = await supabase
    .from('category_rules')
    .upsert({ user_id, ...params }, { onConflict: 'user_id,merchant_entity_id' })
  if (error) throw error
}

/** Permanently deletes a category rule by id. RLS ensures the caller owns it. */
export async function deleteCategoryRule(id: string): Promise<void> {
  const { error } = await supabase
    .from('category_rules')
    .delete()
    .eq('id', id)
  if (error) throw error
}

/**
 * Runs the apply_category_rules RPC: stamps schedule_c_category on the caller's
 * uncategorized transactions that match a saved rule. Returns the count of rows updated.
 */
export async function applyAllCategoryRules(): Promise<number> {
  const user_id = await getUserId()
  const { data, error } = await supabase.rpc('apply_category_rules', { p_user_id: user_id })
  if (error) throw error
  return (data as number) ?? 0
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/mutations.ts
git commit -m "feat: add createOrUpdateCategoryRule, deleteCategoryRule, applyAllCategoryRules"
```

---

### Task 4: TransactionDetail rule hint UI

**Files:**
- Modify: `src/pages/ExpensesPage.tsx`

Context: `TransactionDetail` is defined at line 95. The category section is at lines 310–337. The `qc` (`useQueryClient()`) instance is at line 96. The `catMutation` pattern (lines 108–111) shows the existing mutation style.

- [ ] **Step 1: Update the `queries` import on line 22**

Current:
```typescript
import { useTrade, useCustomCategories } from '../lib/queries'
```

Replace with:
```typescript
import { useTrade, useCustomCategories, useCategoryRules } from '../lib/queries'
```

- [ ] **Step 2: Update the `mutations` import on line 9**

Current:
```typescript
import { updateTransaction, deleteTransaction } from '../lib/mutations'
```

Replace with:
```typescript
import { updateTransaction, deleteTransaction, createOrUpdateCategoryRule, deleteCategoryRule } from '../lib/mutations'
```

- [ ] **Step 3: Add rule state and mutations inside `TransactionDetail`, after line 144 (`const tradeQ = useTrade(...)`)**

Insert immediately after `const tradeQ = useTrade(tx.trade_id ?? null)`:

```typescript
  const { data: rules = [] } = useCategoryRules()
  const existingRule = tx.merchant_entity_id
    ? (rules.find(r => r.merchant_entity_id === tx.merchant_entity_id) ?? null)
    : null

  const saveRuleMutation = useMutation({
    mutationFn: () => createOrUpdateCategoryRule({
      merchant_entity_id: tx.merchant_entity_id!,
      merchant_name: tx.merchant ?? tx.merchant_entity_id!,
      schedule_c_category: tx.schedule_c_category!,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['category_rules'] }),
  })

  const removeRuleMutation = useMutation({
    mutationFn: (id: string) => deleteCategoryRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['category_rules'] }),
  })
```

- [ ] **Step 4: Add the rule hint row to the JSX between the category `</div>` (line 337) and `{/* Details grid */}` (line 339)**

Insert between the closing `</div>` of the Category section and `{/* Details grid */}`:

```tsx
      {/* Auto-categorization rule hint — only for Plaid transactions with a known entity */}
      {tx.merchant_entity_id && tx.schedule_c_category && !tx.trade_id && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs mt-1">
          {existingRule ? (
            <>
              <span className="text-green-700 font-medium">Rule active:</span>
              <span className="text-gray-600">{existingRule.merchant_name} →</span>
              <CategoryBadge value={existingRule.schedule_c_category} />
              {existingRule.schedule_c_category !== tx.schedule_c_category && (
                <button
                  type="button"
                  onClick={() => saveRuleMutation.mutate()}
                  disabled={saveRuleMutation.isPending}
                  className="text-blue-600 hover:underline disabled:opacity-50"
                >
                  Update rule
                </button>
              )}
              <span className="text-gray-300">·</span>
              <button
                type="button"
                onClick={() => removeRuleMutation.mutate(existingRule.id)}
                disabled={removeRuleMutation.isPending}
                className="text-red-500 hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <span className="text-gray-500">
                Always use this category for {tx.merchant ?? 'this merchant'}?
              </span>
              <button
                type="button"
                onClick={() => saveRuleMutation.mutate()}
                disabled={saveRuleMutation.isPending}
                className="text-blue-600 hover:underline font-medium disabled:opacity-50"
              >
                {saveRuleMutation.isPending ? 'Saving…' : 'Save rule'}
              </button>
            </>
          )}
        </div>
      )}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 6: Manual verification in dev server**

```bash
npm run dev
```

Check:
1. Open a Plaid-sourced transaction that has a category set → rule hint "Always use this category for [Merchant]? Save rule" appears below the category selector.
2. Click "Save rule" → hint changes to "Rule active: [Merchant] → [Category] · Remove".
3. Change the transaction category via the dropdown → "Update rule" button appears next to the stale rule category.
4. Click "Update rule" → rule updates to match the new category.
5. Click "Remove" → hint reverts to "Save rule".
6. Open a manual/CSV transaction (no `merchant_entity_id`) → no hint rendered.
7. Open a trade-linked transaction → no hint rendered.
8. Open a Plaid transaction with no category set → no hint rendered.

- [ ] **Step 7: Commit**

```bash
git add src/pages/ExpensesPage.tsx
git commit -m "feat: add auto-categorization rule hint to transaction detail panel"
```

---

### Task 5: SettingsPage rules management section

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

Context: `SettingsPage.tsx` imports `useState`, `useQueryClient`, `useMutation` already. The categories tab section is at lines 379–385. `CustomCategoriesList` is already imported (line 14).

- [ ] **Step 1: Add new imports to `SettingsPage.tsx`**

At the top of the file, add these imports (check for existing lucide-react import and extend it rather than adding a duplicate):

```typescript
import { useCategoryRules } from '../lib/queries'
import { deleteCategoryRule, applyAllCategoryRules } from '../lib/mutations'
import CategoryBadge from '../components/CategoryBadge'
import type { CategoryRule } from '../lib/types'
```

For lucide-react: find the existing lucide import in the file and add `Trash2` to it. For example if it currently reads:
```typescript
import { SomeIcon } from 'lucide-react'
```
Change to:
```typescript
import { SomeIcon, Trash2 } from 'lucide-react'
```
If there is no lucide import yet, add:
```typescript
import { Trash2 } from 'lucide-react'
```

- [ ] **Step 2: Add `CategoryRulesSection` component before `export default function SettingsPage()`**

Insert this function immediately before the `export default function SettingsPage` line:

```typescript
function CategoryRulesSection() {
  const qc = useQueryClient()
  const { data: rules = [], isLoading } = useCategoryRules()
  const [applyCount, setApplyCount] = useState<number | null>(null)

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCategoryRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['category_rules'] }),
  })

  const applyMutation = useMutation({
    mutationFn: applyAllCategoryRules,
    onSuccess: (count) => setApplyCount(count),
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">Auto-categorization Rules</h3>
        <button
          type="button"
          onClick={() => { setApplyCount(null); applyMutation.mutate() }}
          disabled={applyMutation.isPending}
          className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {applyMutation.isPending ? 'Applying…' : 'Apply Rules Now'}
        </button>
      </div>
      {applyCount !== null && (
        <p className="text-xs text-green-600 mb-2">
          Applied rules to {applyCount} transaction{applyCount === 1 ? '' : 's'}.
        </p>
      )}
      {isLoading ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="text-xs text-gray-400">
          No rules yet — open a transaction and set a category to create one.
        </p>
      ) : (
        <div className="divide-y divide-gray-100">
          {rules.map((rule: CategoryRule) => (
            <div key={rule.id} className="flex items-center gap-2 py-2.5">
              <span className="text-sm text-gray-800 flex-1 truncate">{rule.merchant_name}</span>
              <CategoryBadge value={rule.schedule_c_category} />
              <button
                type="button"
                onClick={() => deleteMutation.mutate(rule.id)}
                disabled={deleteMutation.isPending}
                className="ml-1 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
                title="Remove rule"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Update the categories tab section (lines 379–385)**

Find:
```tsx
      {activeTab === 'categories' && (
        <section className="space-y-3">
          <div className="border border-gray-200 rounded-lg bg-white p-4">
            <CustomCategoriesList />
          </div>
        </section>
      )}
```

Replace with:
```tsx
      {activeTab === 'categories' && (
        <section className="space-y-3">
          <div className="border border-gray-200 rounded-lg bg-white p-4">
            <CustomCategoriesList />
          </div>
          <div className="border border-gray-200 rounded-lg bg-white p-4">
            <CategoryRulesSection />
          </div>
        </section>
      )}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 5: Manual verification in dev server**

```bash
npm run dev
```

Check:
1. Go to Settings → Categories tab → "Auto-categorization Rules" section appears below Custom Categories.
2. No rules yet: empty state message shown.
3. Create a rule via the transaction detail panel → return to Settings → Categories → rule listed with trash icon.
4. Click trash icon → rule disappears.
5. Create a rule, then click "Apply Rules Now" → toast "Applied rules to N transactions."

- [ ] **Step 6: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "feat: add Auto-categorization Rules section to Settings categories tab"
```

---

### Task 6: `plaid_sync_transactions` v35 — apply rules at sync time

**Files:**
- Modify: `supabase/functions/plaid_sync_transactions/index.ts`

Context: The current version is v34 (line 1). The freshAdds insertion block begins around line 347. After the upsert loop, the PFC_TO_SCHEDULE_C loop runs at lines 360–368. Rules must run **between** the upsert and the PFC loop so that user rules take precedence over generic Plaid category inference.

- [ ] **Step 1: Update the version comment at the top of the file**

Replace line 1:
```typescript
// plaid_sync_transactions v34
```
with:
```typescript
// plaid_sync_transactions v35
```

Add after line 4 (end of the v34 note):
```typescript
// v35: apply user category_rules to freshly-inserted rows before the PFC
// fallback. One SELECT per sync call fetches all rules that match the batch's
// entity IDs; a per-rule UPDATE stamps only null schedule_c_category rows.
// Rules run before PFC so user-defined mappings take precedence.
```

- [ ] **Step 2: Insert rule application between the upsert loop and the PFC loop**

Find the PFC loop block inside the `if (freshAdds.length > 0)` section:

```typescript
          for (const [pfc, scheduleC] of Object.entries(PFC_TO_SCHEDULE_C)) {
            await supabase
              .from('transactions')
              .update({ schedule_c_category: scheduleC })
              .eq('user_id', user.id)
              .eq('plaid_category', pfc)
              .eq('record_type', 'transaction')
              .is('schedule_c_category', null)
          }
          totalAdded += freshAdds.length
```

Replace with:

```typescript
          // v35: apply user category rules (higher priority than PFC fallback below).
          // One query fetches all matching rules for the batch; per-rule UPDATEs
          // stamp only null schedule_c_category rows.
          const entityIds = [...new Set(
            freshAdds
              .map((tx: any) => tx.merchant_entity_id as string | null | undefined)
              .filter((id): id is string => !!id)
          )]
          if (entityIds.length > 0) {
            const { data: ruleRows } = await supabase
              .from('category_rules')
              .select('merchant_entity_id, schedule_c_category')
              .eq('user_id', user.id)
              .in('merchant_entity_id', entityIds)
            if (ruleRows && ruleRows.length > 0) {
              console.log(`Item ${item.item_id}: applying ${ruleRows.length} category rule(s)`)
              for (const rule of ruleRows) {
                await supabase
                  .from('transactions')
                  .update({ schedule_c_category: rule.schedule_c_category })
                  .eq('user_id', user.id)
                  .eq('merchant_entity_id', rule.merchant_entity_id)
                  .is('schedule_c_category', null)
              }
            }
          }

          // PFC fallback: categorize remaining null rows by Plaid's category signal.
          for (const [pfc, scheduleC] of Object.entries(PFC_TO_SCHEDULE_C)) {
            await supabase
              .from('transactions')
              .update({ schedule_c_category: scheduleC })
              .eq('user_id', user.id)
              .eq('plaid_category', pfc)
              .eq('record_type', 'transaction')
              .is('schedule_c_category', null)
          }
          totalAdded += freshAdds.length
```

- [ ] **Step 3: Visually review the diff**

Confirm:
- Rule lookup block is inside `if (freshAdds.length > 0) {` — yes, it follows the upsert loop
- Both blocks (`category_rules` lookup + PFC loop) end before `totalAdded += freshAdds.length`
- `user.id` used consistently (not `userId` — check which variable name is in scope at this point in the function; it should be `user.id` based on the auth check near the top)
- The `Set` spread correctly deduplicates entity IDs

- [ ] **Step 4: Commit the edge function source**

```bash
git add supabase/functions/plaid_sync_transactions/index.ts
git commit -m "feat: plaid_sync_transactions v35 — apply category rules before PFC fallback"
```

---

### Task 7: Deploy + close out

- [ ] **Step 1: Deploy `plaid_sync_transactions` v35**

```bash
supabase functions deploy plaid_sync_transactions --project-ref qmizmnbzergqbpgyqseg
```

Expected: `Deployed Functions on project qmizmnbzergqbpgyqseg: plaid_sync_transactions`

- [ ] **Step 2: Update `TASKS.md` — mark the item closed**

Find line 123:
```markdown
- [ ] **Merchant auto-categorization rules** — `category_rules` table (mobile backlog item, not yet built on either client); ship on web first since the UI is simpler as a settings table
```

Replace with:
```markdown
- [x] **Merchant auto-categorization rules** — `category_rules` table, Plaid entity-ID-based rule matching, one-click rule creation from transaction detail panel, Settings management section + backfill button. _Shipped 2026-09-23. See [`docs/superpowers/specs/2026-09-23-merchant-auto-categorization-design.md`](docs/superpowers/specs/2026-09-23-merchant-auto-categorization-design.md)._
```

- [ ] **Step 3: Update `docs/features/expenses.md` — add auto-categorization rules section**

Add a new `## Auto-categorization Rules` section to `docs/features/expenses.md` with this content:

```markdown
## Auto-categorization Rules

Rules map a Plaid merchant (`merchant_entity_id`) to a fixed Schedule C category. Once saved, every new transaction from that merchant lands pre-categorized.

**Creating a rule:** Open any Plaid-sourced transaction with a category set. Below the category selector, a hint row appears: "Always use [Category] for [Merchant]? Save rule." One click saves the rule. The hint updates to "Rule active" with a Remove link.

**Editing a rule:** Change the transaction's category via the dropdown. The hint shows "Update rule" — click it to re-save the rule to the new category.

**Removing a rule:** Click "Remove" in the hint row, or use the trash icon in Settings → Categories → Auto-categorization Rules.

**Backfill:** After creating rules, existing uncategorized transactions are not automatically updated. Use Settings → Categories → "Apply Rules Now" to stamp matching rules onto existing null-category rows. The button shows how many rows were updated.

**Scope:** Rules only apply to Plaid-synced transactions (which carry `merchant_entity_id`). Manual and CSV transactions are not affected.
```

- [ ] **Step 4: Final commit**

```bash
git add TASKS.md docs/features/expenses.md
git commit -m "docs: mark merchant auto-categorization rules as shipped; update expenses.md"
```
