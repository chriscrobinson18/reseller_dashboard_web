-- Itemized fee breakdown from eBay Order Earnings import.
-- fee_breakdown stores per-fee-type amounts as JSONB; discount is a simple scalar.
-- Existing sales (manual, Amazon, etc.) keep these null — display falls back to
-- the existing summed `fees` column.

alter table public.sales
  add column fee_breakdown jsonb default null;

alter table public.sales
  add column discount numeric default null;

comment on column public.sales.fee_breakdown is
  'Per-fee-type breakdown from eBay Order Earnings. Keys: final_value_fee_fixed, '
  'final_value_fee_variable, promoted_listing_standard, regulatory_operating, '
  'international, below_standard_performance, item_not_as_described, '
  'deposit_processing, payment_dispute, charity_donation. Values are positive amounts.';

comment on column public.sales.discount is
  'Discount amount from eBay Order Earnings (positive number). Null when no discount.';
