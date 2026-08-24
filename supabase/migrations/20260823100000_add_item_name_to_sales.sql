-- Free-text item description captured by the Apple Shortcuts quick-sale flow.
-- Preserved after item_id is linked so the original entry is never lost.
alter table public.sales
  add column if not exists item_name text;

comment on column public.sales.item_name is
  'Free-text item name from the Apple Shortcuts quick-sale flow. '
  'Preserved after item_id is set.';
