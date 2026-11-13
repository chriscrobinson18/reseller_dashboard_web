-- Re-key existing eBay Transaction Report rows to the collision-proof scheme
-- introduced in supabase/functions/_shared/ebayTransactionReport.ts, so a
-- re-import of the same files adds only the rows the old import dropped.
--
-- Data only (no schema change). Touches source = 'csv_import', platform =
-- 'ebay' rows, which are audit detail: they never reach Schedule C
-- (isSaleDerivedTransaction). Idempotent.
--
-- 1. Shipping label / Charge / Hold-Reserve keys gain "_<date>_<cents>" before
--    the type suffix, e.g.
--      ebay_Tracking no. 1Z…_ship  →  ebay_Tracking no. 1Z…_2025-10-06_-2273_ship
--    (old keys collided when a label and its "Underpaid" adjustment shared a
--    tracking number, or two charges fell on the same day). Cents = the
--    parser's Math.round(amount * 100).
-- 2. The one surviving pair of rows keyed "ebay_0_order" / "ebay_0_fvf" is
--    deleted: 103 orders had Transaction ID "0" and collapsed into that key.
--    The re-import inserts all of them under order-number + item-ID keys.
--
-- Verified before applying (owner's 2025 + 2026 Transaction Report files,
-- 2026-11-13): after this re-key, every existing eBay csv row's key is one the
-- new parser produces, and the files' booked rows sum to eBay's Net amount.

update public.transactions
set csv_transaction_id = regexp_replace(
      csv_transaction_id,
      '_(ship|charge|bal)$',
      '_' || to_char(date, 'YYYY-MM-DD') || '_' || round((amount * 100)::numeric)::bigint || '_\1')
where source = 'csv_import'
  and platform = 'ebay'
  and csv_transaction_id ~ '_(ship|charge|bal)$'
  and csv_transaction_id !~ '_\d{4}-\d{2}-\d{2}_-?\d+_(ship|charge|bal)$';

delete from public.transactions
where source = 'csv_import'
  and platform = 'ebay'
  and csv_transaction_id in ('ebay_0_order', 'ebay_0_fvf')
  and review_status is distinct from 'owner_reviewed';
