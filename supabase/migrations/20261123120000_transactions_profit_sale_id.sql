-- Profit-only attribution of a charge to a sale (2026-11-23).
--
-- A cost you paid directly from a bank/card account for one sale (e.g. a
-- shipping label bought with your own card, not deducted by the platform)
-- stays an ordinary Schedule C expense on its own row. profit_sale_id only
-- lets that sale's profit include it. It is NEVER read by any tax calculation
-- (bucketTransaction / salesIncome / Part III) -- unlike related_sale_id,
-- which marks a row as part of the sale's payout and excludes it from
-- Schedule C. See docs/features/expenses.md "Attribute a charge to a sale".
alter table public.transactions
  add column if not exists profit_sale_id uuid references public.sales(id) on delete set null;

create index if not exists transactions_profit_sale_id_idx
  on public.transactions (profit_sale_id) where profit_sale_id is not null;

comment on column public.transactions.profit_sale_id is
  'Profit attribution only: this charge is a cost of that sale for profitability. Never affects Schedule C.';

-- profit_sale_id is a link: lock it on owner-reviewed transactions like the
-- other link columns (same list as 20261113120000_review_status.sql + it).
create or replace function public.owner_review_locked_fields(tbl text)
 returns text[]
 language sql
 immutable
as $function$
  select case tbl
    -- category / pairing / links
    when 'transactions' then array['schedule_c_category','record_type','net_zero_pair_id','related_sale_id','related_bundle_id',
                                   'trade_id','parent_settlement_id','is_non_cash','review_status','reviewed_at','profit_sale_id']
    -- inventory link + the sale's money
    when 'sales' then array['item_id','bundle_id','trade_id','quantity','sale_price','fees','shipping_cost','shipping_charged',
                            'discount','net_payout','sold_at','platform','deleted_at','review_status','reviewed_at']
    -- what was bought, how many, for how much, when, funded by which charge
    when 'inventory_lots' then array['item_id','transaction_id','trade_id','box_opening_id','quantity_purchased','unit_cost',
                                     'initial_unit_cost','purchase_date','deleted_at','review_status','reviewed_at']
  end
$function$;

-- Sales are soft-deleted (reverse_sale sets deleted_at), so the FK's
-- ON DELETE SET NULL never fires: clear attributions when a sale is deleted.
create or replace function public.clear_profit_attribution_on_sale_delete()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if NEW.deleted_at is not null and OLD.deleted_at is null then
    update public.transactions set profit_sale_id = null where profit_sale_id = NEW.id;
  end if;
  return NEW;
end;
$function$;

drop trigger if exists clear_profit_attribution_on_sale_delete on public.sales;
create trigger clear_profit_attribution_on_sale_delete
  after update of deleted_at on public.sales
  for each row execute function public.clear_profit_attribution_on_sale_delete();
