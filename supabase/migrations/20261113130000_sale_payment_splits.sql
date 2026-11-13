-- Split payments: one order paid across several rails (e.g. $60 cash + $40 Venmo).
--
-- Rare (~1 in 500 sales), so this is a JSON column rather than a child table:
-- no join on every sales read, and record / edit / reverse_sale stay unchanged.
-- Shape: [{"method": "cash", "amount": 60}, {"method": "venmo", "amount": 40}]
-- (method values from src/lib/paymentMethods.ts; amounts sum to the sale price,
-- or to the bundle total on sale_bundles — enforced client-side, since a
-- bundle's total lives on its lines).
--
-- When set, payment_method holds the sentinel 'split' so existing pills, filters
-- and search keep a single value to read. Null payments = one rail covering the
-- whole amount, i.e. every row recorded before this column existed.
--
-- Bundle lines carry payment_method = 'split' with payments null: the
-- breakdown is order-level and lives once on sale_bundles.payments.
--
-- Not added to owner_review_locked_fields(): payment_method isn't locked
-- either — it's descriptive metadata, not an amount that feeds Schedule C.
-- The single payout transaction per sale/bundle is unchanged.

alter table public.sales add column if not exists payments jsonb;
alter table public.sale_bundles add column if not exists payments jsonb;

alter table public.sales
  add constraint sales_payments_shape check (
    payments is null
    or (jsonb_typeof(payments) = 'array' and jsonb_array_length(payments) >= 2 and payment_method = 'split')
  );

alter table public.sale_bundles
  add constraint sale_bundles_payments_shape check (
    (payments is null and payment_method is distinct from 'split')
    or (jsonb_typeof(payments) = 'array' and jsonb_array_length(payments) >= 2 and payment_method = 'split')
  );

comment on column public.sales.payments is
  'Split-payment breakdown [{method, amount}], set only when payment_method = ''split''. Null on bundle lines (split lives on sale_bundles.payments) and on single-rail sales.';
comment on column public.sale_bundles.payments is
  'Split-payment breakdown [{method, amount}] for the whole order, set only when payment_method = ''split''.';
