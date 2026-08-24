-- Create profiles table only if it does not already exist.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade
);

alter table public.profiles enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'profiles'
      and policyname = 'profiles_self_access'
  ) then
    execute $policy$
      create policy "profiles_self_access"
        on public.profiles
        for all
        using  (auth.uid() = id)
        with check (auth.uid() = id)
    $policy$;
  end if;
end
$$;

-- One shortcut token per user; null until the user generates one
alter table public.profiles
  add column if not exists shortcut_token uuid unique;

comment on column public.profiles.shortcut_token is
  'Personal API token for Apple Shortcuts integration. '
  'Regenerating invalidates the previous one. Null = not configured.';
