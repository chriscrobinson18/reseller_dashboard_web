-- link_sale_to_item: link an existing (unlinked) sale to an inventory item and
-- FIFO-deplete that item's lots, exactly like record_sale does for new sales.
-- Added 2026-11-12. Before this, the web client's linkSaleToItem only set
-- sales.item_id, so a linked sale left its units "on hand" and had no
-- inventory_movements (no per-sale COGS).
--
-- Lot order: lots bought on/before the sale date first (oldest purchase first),
-- then later lots (presales) only if needed. Units that can't be covered leave
-- the sale 'oversold'. Refuses a sale that already has inventory movements.
-- SECURITY INVOKER: runs under the caller's RLS (user_id = auth.uid()).

create or replace function public.link_sale_to_item(p_sale_id uuid, p_item_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  s record;
  l record;
  need integer;
  c integer;
  consumed integer := 0;
begin
  select * into s from sales where id = p_sale_id and deleted_at is null for update;
  if not found then raise exception 'Sale not found'; end if;
  if not exists (select 1 from items where id = p_item_id and deleted_at is null and user_id = s.user_id) then
    raise exception 'Item not found';
  end if;
  if exists (select 1 from inventory_movements where sale_id = p_sale_id) then
    raise exception 'This sale is already linked to inventory lots';
  end if;

  need := s.quantity;
  for l in
    select id, quantity_remaining
      from inventory_lots
     where item_id = p_item_id and user_id = s.user_id and deleted_at is null and quantity_remaining > 0
     order by (coalesce(purchase_date, created_at::date) > s.sold_at::date),
              coalesce(purchase_date, created_at::date), created_at
       for update
  loop
    exit when need = 0;
    c := least(need, l.quantity_remaining);
    update inventory_lots set quantity_remaining = quantity_remaining - c where id = l.id;
    insert into inventory_movements (user_id, inventory_lot_id, sale_id, quantity)
      values (s.user_id, l.id, p_sale_id, c);
    need := need - c;
    consumed := consumed + c;
  end loop;

  update sales
     set item_id = p_item_id,
         inventory_status = case when need > 0 then 'oversold' else 'ok' end
   where id = p_sale_id;

  return jsonb_build_object('consumed', consumed, 'unfulfilled', need);
end;
$$;

revoke all on function public.link_sale_to_item(uuid, uuid) from public, anon;
grant execute on function public.link_sale_to_item(uuid, uuid) to authenticated;
