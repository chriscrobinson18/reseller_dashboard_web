alter table public.plaid_items
  add column status text not null default 'active'
    check (status in ('active', 'login_required', 'error')),
  add column error_message text;

comment on column public.plaid_items.status is
  'Connection health: active = normal, login_required = needs Plaid Link update mode, error = generic failure.';
