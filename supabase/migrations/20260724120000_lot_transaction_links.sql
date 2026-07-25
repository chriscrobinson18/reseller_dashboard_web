-- inventory_lot_transactions: many-to-many funding links between a purchase lot
-- and the transaction(s) that paid for it, with the amount each one contributed.
--
-- Motivation: split-tender purchases. A single eBay order can be paid part on a
-- credit card (which syncs via Plaid) and part from marketplace balance (which
-- never touches a bank and has to be entered by hand). The old single
-- `inventory_lots.transaction_id` FK could only point at one of them, so the
-- reconciliation panel permanently reported the lot as exceeding its purchase.
--
-- `allocated_amount` is the unsigned magnitude this transaction contributed to
-- the lot's cost. Summing it per transaction tells you how much of that purchase
-- has been turned into inventory; summing per lot should equal the lot's total
-- cost (quantity_purchased * unit_cost).
--
-- `inventory_lots.transaction_id` is deliberately KEPT and kept in sync with the
-- primary (first) link, because the sibling iOS app still reads that column.
-- Web treats this table as the source of truth; iOS keeps working unchanged.

create table public.inventory_lot_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lot_id uuid not null references public.inventory_lots(id) on delete cascade,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  allocated_amount numeric not null check (allocated_amount >= 0),
  created_at timestamptz not null default now(),
  unique (lot_id, transaction_id)
);

create index inventory_lot_transactions_lot_id_idx
  on public.inventory_lot_transactions(lot_id);
create index inventory_lot_transactions_transaction_id_idx
  on public.inventory_lot_transactions(transaction_id);
create index inventory_lot_transactions_user_id_idx
  on public.inventory_lot_transactions(user_id);

alter table public.inventory_lot_transactions enable row level security;

create policy "inventory_lot_transactions_owner_select" on public.inventory_lot_transactions
  for select using (auth.uid() = user_id);
create policy "inventory_lot_transactions_owner_insert" on public.inventory_lot_transactions
  for insert with check (auth.uid() = user_id);
create policy "inventory_lot_transactions_owner_update" on public.inventory_lot_transactions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "inventory_lot_transactions_owner_delete" on public.inventory_lot_transactions
  for delete using (auth.uid() = user_id);

-- Backfill: every currently-linked lot becomes one link funding its full cost.
insert into public.inventory_lot_transactions (user_id, lot_id, transaction_id, allocated_amount)
select l.user_id, l.id, l.transaction_id, round((l.quantity_purchased * l.unit_cost)::numeric, 2)
from public.inventory_lots l
where l.transaction_id is not null
  and l.deleted_at is null
on conflict (lot_id, transaction_id) do nothing;

comment on table public.inventory_lot_transactions is
  'Funding links between an inventory lot and the transaction(s) that paid for it. Supports split-tender purchases. inventory_lots.transaction_id mirrors the primary link for iOS compatibility.';
comment on column public.inventory_lot_transactions.allocated_amount is
  'Unsigned magnitude this transaction contributed toward the lot cost. Per-lot sum should equal quantity_purchased * unit_cost.';
