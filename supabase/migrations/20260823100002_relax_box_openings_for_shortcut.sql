-- Allow shortcut-initiated breakdown records where source_lot_id is not yet
-- known. These are detected by source_lot_id IS NULL in the web UI.

-- Drop existing constraints and re-add with null-permissive versions
alter table public.box_openings
  drop constraint if exists box_openings_box_cost_check,
  drop constraint if exists box_openings_allocation_method_check;

alter table public.box_openings
  add constraint box_openings_box_cost_check
    check (box_cost is null or box_cost > 0),
  add constraint box_openings_allocation_method_check
    check (allocation_method is null or allocation_method in ('relative_fmv', 'specific_id', 'equal'));

-- Allow both columns to be null
alter table public.box_openings
  alter column box_cost       drop not null,
  alter column allocation_method drop not null;

comment on column public.box_openings.source_lot_id is
  'The inventory_lots row this box was opened from. '
  'NULL for shortcut-initiated breakdowns awaiting completion in the web app.';
