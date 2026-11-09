-- sales.shipping_charged: shipping the BUYER paid the seller (income).
--
-- Until now `shipping_cost` meant two opposite things: seller-paid postage
-- deducted by the platform (eBay Order Earnings "Shipping labels" — an
-- expense) and, for TCGplayer imports, buyer-paid shipping credited to the
-- seller (income; TCGplayer net = product − fees + shipping). Schedule C now
-- sources income from `sales`, so the two must be separate:
--   Line 1 gross receipts += sale_price + shipping_charged
--   Line 27a shipping     += shipping_cost (platform-deducted labels)
-- eBay's "Gross amount" already includes buyer-paid shipping inside
-- sale_price, so eBay rows leave shipping_charged null.
alter table public.sales add column if not exists shipping_charged numeric;

comment on column public.sales.shipping_charged is
  'Shipping paid by the buyer to the seller (income, Schedule C Line 1). Separate from shipping_cost (seller-paid postage, expense).';

-- One-time move of TCGplayer buyer-paid shipping out of shipping_cost.
update public.sales
set shipping_charged = shipping_cost,
    shipping_cost = null
where platform = 'tcgplayer'
  and source = 'tcgplayer'
  and shipping_charged is null
  and shipping_cost is not null;
