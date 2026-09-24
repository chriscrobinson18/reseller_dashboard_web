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
