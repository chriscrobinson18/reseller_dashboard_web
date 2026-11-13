-- Review markers (owner decision 2026-11-13).
--
-- Goal: (1) show which records an AI assistant has checked or changed, and (2) stop anything other than the
-- owner from changing a record the owner has confirmed. Focus: categories, sale<->inventory links, inventory lots.
--
-- review_status on transactions, sales, inventory_lots:
--   null              not reviewed
--   'ai_reviewed'     written or changed by an AI assistant; waiting for the owner to confirm
--   'owner_reviewed'  confirmed by the owner: set in stone
--
-- Who is who (from the PostgREST JWT):
--   owner     = app session ('authenticated') whose auth.uid() owns the row: may do anything, including un-marking
--   service   = 'service_role' edge functions (Plaid sync, marketplace imports, record_sale/record_return run on
--               the owner's behalf): protected fields on an owner-reviewed row are kept as they were (no error,
--               so a sync or import never fails), deletes of an owner-reviewed row are skipped
--   anyone else (direct SQL, admin scripts, AI assistants): any change to a protected field, or delete, of an
--               owner-reviewed row raises an error
-- Only the owner may set review_status to 'owner_reviewed' or move it away from that.
--
-- Protected fields are the reviewed decisions only. Bank facts (amount, date, merchant) and later events
-- (lot quantity_remaining, sale refunds/returns) stay writable, so sales and returns keep working.

alter table public.transactions   add column if not exists review_status text check (review_status in ('ai_reviewed','owner_reviewed')),
                                  add column if not exists reviewed_at timestamptz;
alter table public.sales          add column if not exists review_status text check (review_status in ('ai_reviewed','owner_reviewed')),
                                  add column if not exists reviewed_at timestamptz;
alter table public.inventory_lots add column if not exists review_status text check (review_status in ('ai_reviewed','owner_reviewed')),
                                  add column if not exists reviewed_at timestamptz;

create or replace function public.review_jwt_role()
returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
$$;

create or replace function public.owner_review_locked_fields(tbl text)
returns text[] language sql immutable as $$
  select case tbl
    -- category / pairing / links
    when 'transactions' then array['schedule_c_category','record_type','net_zero_pair_id','related_sale_id','related_bundle_id',
                                   'trade_id','parent_settlement_id','is_non_cash','review_status','reviewed_at']
    -- inventory link + the sale's money
    when 'sales' then array['item_id','bundle_id','trade_id','quantity','sale_price','fees','shipping_cost','shipping_charged',
                            'discount','net_payout','sold_at','platform','deleted_at','review_status','reviewed_at']
    -- what was bought, how many, for how much, when, funded by which charge
    when 'inventory_lots' then array['item_id','transaction_id','trade_id','box_opening_id','quantity_purchased','unit_cost',
                                     'initial_unit_cost','purchase_date','deleted_at','review_status','reviewed_at']
  end
$$;

create or replace function public.enforce_owner_review_lock()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  jwt_role text := public.review_jwt_role();
  row_user uuid := case when TG_OP = 'INSERT' then NEW.user_id else OLD.user_id end;
  is_owner boolean := jwt_role = 'authenticated' and auth.uid() is not null and auth.uid() = row_user;
  locked   text[] := public.owner_review_locked_fields(TG_TABLE_NAME);
  o jsonb; n jsonb; k text; changed text[] := '{}';
begin
  if is_owner then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;

  if TG_OP = 'INSERT' then
    if NEW.review_status = 'owner_reviewed' then
      raise exception 'Only the owner can mark a record as reviewed by owner';
    end if;
    return NEW;
  end if;

  if TG_OP = 'UPDATE' and OLD.review_status is distinct from 'owner_reviewed' then
    if NEW.review_status = 'owner_reviewed' then
      raise exception 'Only the owner can mark a record as reviewed by owner';
    end if;
    return NEW;
  end if;

  if TG_OP = 'DELETE' then
    if OLD.review_status is distinct from 'owner_reviewed' then return OLD; end if;
    if jwt_role = 'service_role' then return null; end if;           -- skip silently
    raise exception '% % is reviewed by owner and locked', TG_TABLE_NAME, OLD.id;
  end if;

  -- UPDATE of an owner-reviewed row by someone other than the owner.
  o := to_jsonb(OLD); n := to_jsonb(NEW);
  foreach k in array locked loop
    if (o -> k) is distinct from (n -> k) then changed := changed || k; end if;
  end loop;
  if cardinality(changed) = 0 then return NEW; end if;             -- only unprotected fields changed
  if jwt_role = 'service_role' then
    return jsonb_populate_record(NEW, (select jsonb_object_agg(f, o -> f) from unnest(locked) f));
  end if;
  raise exception '% % is reviewed by owner and locked (fields: %)', TG_TABLE_NAME, OLD.id, array_to_string(changed, ', ');
end;
$$;

-- Link tables: a sale's inventory link lives in inventory_movements, a lot's funding charge in
-- inventory_lot_transactions. Anyone other than the owner or a service-role function (record_sale etc.)
-- may not add, change or remove a link that touches an owner-reviewed sale, lot or transaction.
create or replace function public.enforce_owner_review_link_lock()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  jwt_role text := public.review_jwt_role();
  r record;
  hit text;
begin
  if jwt_role in ('authenticated', 'service_role') then          -- RLS already limits authenticated users to their own rows
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;
  for r in select * from (values (case when TG_OP <> 'INSERT' then to_jsonb(OLD) end),
                                 (case when TG_OP <> 'DELETE' then to_jsonb(NEW) end)) v(j) where j is not null loop
    if TG_TABLE_NAME = 'inventory_movements' then
      select 'sale ' || s.id into hit from public.sales s where s.id = (r.j ->> 'sale_id')::uuid and s.review_status = 'owner_reviewed';
      if hit is null then
        select 'lot ' || l.id into hit from public.inventory_lots l where l.id = (r.j ->> 'inventory_lot_id')::uuid and l.review_status = 'owner_reviewed';
      end if;
    else
      select 'lot ' || l.id into hit from public.inventory_lots l where l.id = (r.j ->> 'lot_id')::uuid and l.review_status = 'owner_reviewed';
      if hit is null then
        select 'transaction ' || t.id into hit from public.transactions t where t.id = (r.j ->> 'transaction_id')::uuid and t.review_status = 'owner_reviewed';
      end if;
    end if;
    if hit is not null then
      raise exception '% link touches % which is reviewed by owner and locked', TG_TABLE_NAME, hit;
    end if;
  end loop;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

drop trigger if exists owner_review_lock on public.transactions;
create trigger owner_review_lock before insert or update or delete on public.transactions
  for each row execute function public.enforce_owner_review_lock();
drop trigger if exists owner_review_lock on public.sales;
create trigger owner_review_lock before insert or update or delete on public.sales
  for each row execute function public.enforce_owner_review_lock();
drop trigger if exists owner_review_lock on public.inventory_lots;
create trigger owner_review_lock before insert or update or delete on public.inventory_lots
  for each row execute function public.enforce_owner_review_lock();
drop trigger if exists owner_review_lock on public.inventory_movements;
create trigger owner_review_lock before insert or update or delete on public.inventory_movements
  for each row execute function public.enforce_owner_review_link_lock();
drop trigger if exists owner_review_lock on public.inventory_lot_transactions;
create trigger owner_review_lock before insert or update or delete on public.inventory_lot_transactions
  for each row execute function public.enforce_owner_review_link_lock();

create index if not exists transactions_review_status_idx   on public.transactions (review_status)   where review_status is not null;
create index if not exists sales_review_status_idx          on public.sales (review_status)          where review_status is not null;
create index if not exists inventory_lots_review_status_idx on public.inventory_lots (review_status) where review_status is not null;
