-- Expand sales_source_check to allow platform-specific source values.
-- Previous constraint only allowed 'manual', 'csv_import', 'trade'.
-- eBay Order Earnings import uses source='ebay'; Amazon sync uses source='amazon'.

alter table public.sales
  drop constraint sales_source_check;

alter table public.sales
  add constraint sales_source_check
  check (source = any(array['manual','csv_import','trade','ebay','amazon','tcgplayer','plaid']));
