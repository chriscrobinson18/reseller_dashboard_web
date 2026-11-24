-- resolve_sale_refund v2 (2026-11-24): 'kept' with no item chosen no longer
-- refuses. It records the decision (in-app returns removed, refunded_quantity
-- 0) and marks the sale inventory_status = 'oversold' with no units: "buyer
-- kept it / lost, link needed". The Sales list and Dashboard then ask for the
-- inventory link (needsInventoryLink in src/lib/saleInventory.ts). Linking it
-- later (link_sale_to_item or this function with an item) takes the units.
-- Everything else is unchanged from 20261123140000_resolve_sale_refund.sql.

create or replace function public.resolve_sale_refund(p_sale_id uuid, p_outcome text, p_item_id uuid default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  s record;
  m record;
  l record;
  v_item uuid;
  v_out integer;
  v_need integer;
  v_c integer;
  v_restored integer := 0;
  v_taken integer := 0;
  v_ret_qty integer;
  v_ret_amt numeric;
  v_added integer := 0;
  v_removed integer := 0;
begin
  if p_outcome not in ('back', 'kept') then raise exception 'Outcome must be back or kept'; end if;
  select * into s from sales where id = p_sale_id and deleted_at is null for update;
  if not found then raise exception 'Sale not found'; end if;
  if s.trade_id is not null then raise exception 'Trade sales are handled by the trade'; end if;
  if coalesce(s.return_status, 'none') <> 'full' then raise exception 'Only fully refunded sales can be resolved here'; end if;

  if p_outcome = 'back' then
    -- 1. every unit back on its own lot
    for m in select mv.id, mv.inventory_lot_id, mv.quantity from inventory_movements mv where mv.sale_id = p_sale_id for update loop
      update inventory_lots set quantity_remaining = quantity_remaining + m.quantity
       where id = m.inventory_lot_id and quantity_remaining + m.quantity <= quantity_purchased;
      if not found then raise exception 'Lot % would exceed its purchased quantity; fix the lot first', m.inventory_lot_id; end if;
      delete from inventory_movements where id = m.id;
      v_restored := v_restored + m.quantity;
    end loop;
    -- 2. returns rows cover the full quantity; refund never added twice
    select coalesce(sum(quantity), 0), coalesce(sum(refund_amount), 0) into v_ret_qty, v_ret_amt from returns where sale_id = p_sale_id;
    if v_ret_qty < s.quantity then
      insert into returns (user_id, sale_id, quantity, refund_amount, reason, source)
      values (s.user_id, p_sale_id, s.quantity - v_ret_qty, greatest(coalesce(s.refunded_amount, 0) - v_ret_amt, 0),
              'Resolved: came back / never shipped', 'manual');
      v_added := 1;
    end if;
    update sales set refunded_quantity = s.quantity, inventory_status = 'reconciled' where id = p_sale_id;
    return jsonb_build_object('outcome', 'back', 'units_restored', v_restored, 'returns_added', v_added);
  end if;

  -- p_outcome = 'kept'
  delete from returns where sale_id = p_sale_id and refund_transaction_id is null and return_shipping_transaction_id is null;
  get diagnostics v_removed = row_count;
  if exists (select 1 from returns where sale_id = p_sale_id) then
    raise exception 'This sale has a return reconciled with imported transactions; undo that return first';
  end if;
  select coalesce(sum(quantity), 0) into v_out from inventory_movements where sale_id = p_sale_id;
  v_need := s.quantity - v_out;
  if v_need > 0 then
    v_item := coalesce(p_item_id, s.item_id);
    if v_item is null then
      -- Decision recorded, item not known yet (e.g. a single card from a box
      -- not broken down yet): 'oversold' with no units = "kept, link needed",
      -- so the Sales list asks for the link like any unlinked sale.
      update sales set refunded_quantity = 0, inventory_status = 'oversold' where id = p_sale_id;
      return jsonb_build_object('outcome', 'kept', 'units_taken', 0, 'unfulfilled', v_need, 'returns_removed', v_removed, 'needs_item', true);
    end if;
    if not exists (select 1 from items where id = v_item and deleted_at is null and user_id = s.user_id) then
      raise exception 'Item not found';
    end if;
    for l in
      select id, quantity_remaining from inventory_lots
       where item_id = v_item and user_id = s.user_id and deleted_at is null and quantity_remaining > 0
       order by (coalesce(purchase_date, created_at::date) > s.sold_at::date), coalesce(purchase_date, created_at::date), created_at
         for update
    loop
      exit when v_need = 0;
      v_c := least(v_need, l.quantity_remaining);
      update inventory_lots set quantity_remaining = quantity_remaining - v_c where id = l.id;
      insert into inventory_movements (user_id, inventory_lot_id, sale_id, quantity) values (s.user_id, l.id, p_sale_id, v_c);
      v_need := v_need - v_c;
      v_taken := v_taken + v_c;
    end loop;
    update sales set item_id = v_item where id = p_sale_id and item_id is distinct from v_item;
  end if;
  update sales set refunded_quantity = 0, inventory_status = case when v_need > 0 then 'oversold' else 'ok' end where id = p_sale_id;
  return jsonb_build_object('outcome', 'kept', 'units_taken', v_taken, 'unfulfilled', greatest(v_need, 0), 'returns_removed', v_removed);
end;
$$;

revoke all on function public.resolve_sale_refund(uuid, text, uuid) from public, anon;
grant execute on function public.resolve_sale_refund(uuid, text, uuid) to authenticated;
