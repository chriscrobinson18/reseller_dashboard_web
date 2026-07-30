-- sale_payment_methods: split-tender receipts. A single sale (or bundle order)
-- can be paid for with more than one rail — e.g. $300 cash + $100 PayPal for
-- one item. The old `sales.payment_method` / `sale_bundles.payment_method`
-- scalar column can only name one rail, so it can't represent a split.
--
-- Mirrors the `inventory_lot_transactions` precedent (split-tender purchases,
-- see 20260724120000_lot_transaction_links.sql) but for the sale side: many
-- payment rows can point at one sale or one bundle, each carrying the amount
-- that rail actually contributed. Attaches to a sale OR a bundle, never both —
-- bundles already keep payment_method at the order level (one payout for
-- several lines), so a split on a bundle line's order behaves the same way.
--
-- The legacy scalar `payment_method` column on sales/sale_bundles is KEPT and
-- kept in sync with the single rail when there's exactly one (same reasoning
-- as inventory_lots.transaction_id: the sibling iOS app only knows that
-- column and has no concept of a split). It's set to null when there are two
-- or more rails, since no single value can represent that case.
--
-- UI-wise this is offered for any sale, but the "add another payment method"
-- control only shows for manual sales — marketplace payouts (eBay, Amazon,
-- etc.) always settle as one payment from the platform.

create table public.sale_payment_methods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid references public.sales(id) on delete cascade,
  bundle_id uuid references public.sale_bundles(id) on delete cascade,
  payment_method text not null,
  amount numeric not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint sale_payment_methods_one_parent
    check ((sale_id is not null) <> (bundle_id is not null))
);

create index sale_payment_methods_sale_id_idx on public.sale_payment_methods(sale_id);
create index sale_payment_methods_bundle_id_idx on public.sale_payment_methods(bundle_id);
create index sale_payment_methods_user_id_idx on public.sale_payment_methods(user_id);

alter table public.sale_payment_methods enable row level security;

create policy "sale_payment_methods_owner_select" on public.sale_payment_methods
  for select using (auth.uid() = user_id);
create policy "sale_payment_methods_owner_insert" on public.sale_payment_methods
  for insert with check (auth.uid() = user_id);
create policy "sale_payment_methods_owner_update" on public.sale_payment_methods
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "sale_payment_methods_owner_delete" on public.sale_payment_methods
  for delete using (auth.uid() = user_id);

comment on table public.sale_payment_methods is
  'Split-tender receipt rows for a sale or bundle order: one row per payment rail plus the amount it contributed. sales.payment_method / sale_bundles.payment_method mirrors the single rail when there is exactly one, for iOS compatibility, and is null when the payment is split across two or more rails.';
comment on column public.sale_payment_methods.amount is
  'Unsigned amount this rail contributed. Per-sale (or per-bundle) sum should equal the sale/order total.';
