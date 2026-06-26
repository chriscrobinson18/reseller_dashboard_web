alter table public.transactions
  add column merchant_logo_url text,
  add column merchant_website text,
  add column merchant_entity_id text,
  add column location_city text,
  add column location_region text,
  add column location_store_number text,
  add column payment_channel text,
  add column authorized_date date,
  add column iso_currency_code text,
  add column pending boolean not null default false,
  add column pending_plaid_transaction_id text,
  add column plaid_category_detailed text,
  add column plaid_category_confidence text,
  add column plaid_metadata jsonb;

comment on column public.transactions.plaid_metadata is
  'Raw Plaid transactionsSync row as-is. Safety net for fields not broken out into typed columns.';
comment on column public.transactions.pending is
  'Plaid pending flag. Pending rows still count toward Schedule C totals (cash-basis treatment unchanged).';
comment on column public.transactions.pending_plaid_transaction_id is
  'When set on a posted row, points to the prior pending row''s plaid_transaction_id. Used by sync to rename pending rows in place rather than delete+insert.';
