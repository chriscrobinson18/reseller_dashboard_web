-- trades: first-class barter exchange of inventory.
--
-- A trade records both legs of a swap:
--   * given side: items leaving inventory (each becomes a `sales` row, source='trade')
--   * received side: items entering inventory (each becomes an `inventory_lots` row, unit_cost=allocated FMV)
--
-- Schedule C: two non-cash transactions (income + COGS) always wash each other;
-- an optional cash_boot transaction carries the real net cash impact (if any).
--
-- See docs/superpowers/specs/2026-06-23-trades-design.md for the full accounting model.

create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  traded_at date not null,
  counterparty text,
  given_fmv numeric not null check (given_fmv >= 0),
  received_fmv numeric not null check (received_fmv >= 0),
  cash_boot numeric not null default 0,
  cash_transaction_id uuid references public.transactions(id) on delete set null,
  income_transaction_id uuid references public.transactions(id) on delete set null,
  cogs_transaction_id uuid references public.transactions(id) on delete set null,
  fmv_source_notes text,
  notes text
);

create index trades_user_id_idx on public.trades(user_id);
create index trades_traded_at_idx on public.trades(traded_at);

alter table public.trades enable row level security;

create policy "trades_owner_select" on public.trades
  for select using (auth.uid() = user_id);
create policy "trades_owner_insert" on public.trades
  for insert with check (auth.uid() = user_id);
create policy "trades_owner_update" on public.trades
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "trades_owner_delete" on public.trades
  for delete using (auth.uid() = user_id);

-- Link columns on existing tables. All nullable + ON DELETE SET NULL so
-- deleting a trade doesn't cascade-delete its sales/lots/transactions.
alter table public.sales add column trade_id uuid references public.trades(id) on delete set null;
create index sales_trade_id_idx on public.sales(trade_id);

alter table public.inventory_lots add column trade_id uuid references public.trades(id) on delete set null;
create index inventory_lots_trade_id_idx on public.inventory_lots(trade_id);

alter table public.transactions add column trade_id uuid references public.trades(id) on delete set null;
alter table public.transactions add column is_non_cash boolean not null default false;
create index transactions_trade_id_idx on public.transactions(trade_id);
