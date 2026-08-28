-- Extend transactions.source CHECK to include 'ebay_api' for eBay Finances API sync
ALTER TABLE public.transactions
  DROP CONSTRAINT transactions_source_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_source_check
  CHECK (source = ANY (ARRAY['plaid'::text, 'manual'::text, 'csv_import'::text, 'ebay_api'::text]));
