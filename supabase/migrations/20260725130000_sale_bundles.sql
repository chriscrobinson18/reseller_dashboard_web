-- sale_bundles: one sale event that disposes of several DIFFERENT inventory
-- items for one combined payout (e.g. a multi-item eBay order, or a single
-- in-person sale of a mixed lot).
--
-- Deliberately NOT modeled by adding more columns to `sales` — a sale row is
-- one item_id/quantity/sale_price, and FIFO depletion in record_sale assumes
-- exactly one item per call. Restructuring `sales` into a header/line-item
-- table would touch FIFO depletion, inventory_movements, returns, and
-- reverse_sale — all of which already work correctly for the single-item case.
--
-- Instead this follows the `trades` precedent already in this schema: create
-- one ordinary `sales` row per item (via the existing record_sale edge
-- function, untouched), then link them with a parent id. Each line carries its
-- own user-entered price, so per-item profit/margin (saleProfit.ts) works with
-- zero changes — it already reads sale.sale_price per row.
--
-- The one thing that can't live on a line: fees/shipping/payout are ONE
-- number for the whole order, not N. `trades` solved the equivalent problem
-- by keeping transaction FKs on the trade row rather than the individual
-- sales; this does the same via `transactions.related_bundle_id`, so exactly
-- one payout/fee/shipping transaction is created per bundle regardless of
-- line count — reusing recordSale()'s per-sale createSaleTransactions() here
-- would have multiplied the real payout by the number of lines.

create table public.sale_bundles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  sold_at date not null,
  platform text,
  payment_method text,
  external_order_id text,
  fees numeric not null default 0 check (fees >= 0),
  shipping_cost numeric check (shipping_cost is null or shipping_cost >= 0),
  notes text
);

create index sale_bundles_user_id_idx on public.sale_bundles(user_id);
create index sale_bundles_sold_at_idx on public.sale_bundles(sold_at);

alter table public.sale_bundles enable row level security;

create policy "sale_bundles_owner_select" on public.sale_bundles
  for select using (auth.uid() = user_id);
create policy "sale_bundles_owner_insert" on public.sale_bundles
  for insert with check (auth.uid() = user_id);
create policy "sale_bundles_owner_update" on public.sale_bundles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "sale_bundles_owner_delete" on public.sale_bundles
  for delete using (auth.uid() = user_id);

-- Nullable + ON DELETE SET NULL, same as trade_id: deleting a bundle goes
-- through deleteBundleSale (reverses lines via reverse_sale first), but this
-- guards against an orphaned bundle row never leaving sales/transactions
-- pointing at a dead id.
alter table public.sales add column bundle_id uuid references public.sale_bundles(id) on delete set null;
create index sales_bundle_id_idx on public.sales(bundle_id);

alter table public.transactions add column related_bundle_id uuid references public.sale_bundles(id) on delete set null;
create index transactions_related_bundle_id_idx on public.transactions(related_bundle_id);
