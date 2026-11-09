-- inventory_valuations: year-end inventory value per tax year (Schedule C
-- Part III, traditional §471 method — owner decision 2026-11-09).
--
--   Line 35 beginning inventory = ending_inventory of (tax_year − 1)
--   Line 36 purchases           = cost_of_goods transactions in the year
--   Line 41 ending inventory    = ending_inventory of tax_year
--   Line 42 COGS                = 35 + 36 − 41
--
-- One row per (user, tax_year). Beginning inventory is never stored
-- separately: it is always the prior year's row, so the two can't disagree.
-- For the first tracked year, store the prior year's ending value from the
-- filed return (e.g. a tax_year 2024 row for 2025's beginning inventory).
--
-- Deliberately NOT in browser storage (mobile's UserDefaults mistake) and
-- NOT period-scoped: Part III is always a full tax year.

create table public.inventory_valuations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tax_year integer not null check (tax_year between 2000 and 2100),
  ending_inventory numeric(12,2) not null check (ending_inventory >= 0),
  -- How the value was arrived at, for the preparer: a physical count, an
  -- estimate, the app's lot-based figure, or taken from a filed return.
  method text not null default 'count'
    check (method in ('count', 'estimate', 'lots', 'filed_return')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_valuations_user_year_key unique (user_id, tax_year)
);

alter table public.inventory_valuations enable row level security;

create policy "inventory_valuations_owner_select" on public.inventory_valuations
  for select using (auth.uid() = user_id);
create policy "inventory_valuations_owner_insert" on public.inventory_valuations
  for insert with check (auth.uid() = user_id);
create policy "inventory_valuations_owner_update" on public.inventory_valuations
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "inventory_valuations_owner_delete" on public.inventory_valuations
  for delete using (auth.uid() = user_id);
