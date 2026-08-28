-- Allow 'ebay_api' as a source in the sales table
ALTER TABLE sales DROP CONSTRAINT sales_source_check;
ALTER TABLE sales ADD CONSTRAINT sales_source_check
  CHECK (source = ANY (ARRAY[
    'manual','amazon','ebay','tcgplayer','csv_import','trade','ebay_api'
  ]));

-- Dedup index: one sales row per eBay order line item per user
CREATE UNIQUE INDEX IF NOT EXISTS sales_ebay_api_order_dedup
  ON sales (user_id, external_order_id)
  WHERE source = 'ebay_api' AND deleted_at IS NULL;
