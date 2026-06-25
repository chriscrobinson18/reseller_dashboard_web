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
  color_key text not null check (color_key in (
    'emerald','sky','rose','amber','violet','slate',
    'orange','teal','indigo','pink','lime','cyan'
  )),
  -- parent_value and schedule_line are validated client-side against
  -- CATEGORIES[].value (resp. CATEGORIES[].scheduleLine). No DB CHECK
  -- here so adding a new built-in to src/lib/categories.ts does not
  -- require a follow-up migration. Unknown values resolve to undefined
  -- in resolveCategory() and the transaction drops out of Schedule C
  -- (treated as uncategorized) — accepted per spec.
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
