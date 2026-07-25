-- Maintain inventory_lots.transaction_id in the database instead of the client.
--
-- That column is a denormalized mirror of the primary (oldest) funding link in
-- inventory_lot_transactions, kept only so the sibling iOS app keeps working.
-- The web client previously recomputed it with a read-then-write pair, which
-- races: a concurrent link and unlink on the same lot can interleave so the
-- stale reader wins and leaves transaction_id pointing at a link that has since
-- been deleted. The FK still resolves, so nothing errors — iOS just displays a
-- purchase link the web app no longer has.
--
-- Doing it in a trigger makes the mirror atomic with the change that caused it,
-- and correct for every writer, including ON DELETE CASCADE from transactions.

create or replace function public.sync_lot_primary_transaction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_lot uuid;
begin
  target_lot := coalesce(new.lot_id, old.lot_id);

  update public.inventory_lots l
  set transaction_id = (
    select t.transaction_id
    from public.inventory_lot_transactions t
    where t.lot_id = target_lot
    order by t.created_at asc, t.id asc
    limit 1
  )
  where l.id = target_lot;

  return coalesce(new, old);
end;
$$;

comment on function public.sync_lot_primary_transaction is
  'Recomputes inventory_lots.transaction_id from the oldest inventory_lot_transactions row for that lot. Keeps the iOS-facing mirror atomic; do not maintain it from client code.';

drop trigger if exists inventory_lot_transactions_sync_primary
  on public.inventory_lot_transactions;

create trigger inventory_lot_transactions_sync_primary
after insert or update or delete on public.inventory_lot_transactions
for each row execute function public.sync_lot_primary_transaction();

-- Repair any rows the client-side version may already have left inconsistent.
update public.inventory_lots l
set transaction_id = (
  select t.transaction_id
  from public.inventory_lot_transactions t
  where t.lot_id = l.id
  order by t.created_at asc, t.id asc
  limit 1
)
where exists (select 1 from public.inventory_lot_transactions t where t.lot_id = l.id)
   or l.transaction_id is not null;
