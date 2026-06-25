-- Extend sales_source_check to include 'trade' as a valid source.
--
-- The trades feature (migration 20260624120000_trades.sql) added a `trade_id`
-- column on `sales` and the TypeScript Sale.source union added 'trade' as an
-- allowed value, but the existing CHECK constraint was not updated. Result:
-- every recordTrade attempt failed when record_sale tried to insert a
-- sales row with source='trade'.
--
-- Fix is purely additive: drop the old constraint and recreate it with
-- 'trade' added to the allowed set.

alter table public.sales drop constraint sales_source_check;

alter table public.sales add constraint sales_source_check
  check (source = any (array[
    'manual'::text,
    'amazon'::text,
    'ebay'::text,
    'tcgplayer'::text,
    'csv_import'::text,
    'trade'::text
  ]));
