-- Add CHECK constraint on color_key to enforce the fixed 12-key palette.
-- The original migration (20260625120000) was already applied without this
-- constraint; this additive migration closes the gap.
alter table public.custom_categories
  add constraint custom_categories_color_key_check
  check (color_key in (
    'emerald','sky','rose','amber','violet','slate',
    'orange','teal','indigo','pink','lime','cyan'
  ));
