-- box_openings now opens a box the user already holds as inventory, instead of
-- typing a name/cost by hand.
--
-- Rationale for the change: a sealed box is ordinarily bought and entered into
-- inventory the same way as any other item — Add Item + Add Lot, purchase
-- transaction linked and categorized cost_of_goods at purchase time, same as
-- everything else this app tracks. That means the box's cost is *already*
-- deducted on Schedule C by the time it's opened. The original box_openings
-- design (2026-06-23) assumed the box hadn't been recorded yet and posted a
-- fresh cost_of_goods transaction at open time — which would double-deduct a
-- box that was already purchased and linked like a normal lot.
--
-- New model: opening a box depletes an existing inventory_lots row
-- (source_lot_id, quantity units) instead of creating a transaction. The
-- resulting card lots share the source lot's transaction_id (if any) rather
-- than a new one — no new Schedule C entry, because none is owed.
alter table public.box_openings
  add column source_lot_id uuid references public.inventory_lots(id) on delete set null,
  add column quantity integer not null default 1 check (quantity > 0);

create index box_openings_source_lot_id_idx on public.box_openings(source_lot_id);

comment on column public.box_openings.source_lot_id is
  'The inventory_lots row this box was opened from (a box already held in inventory). ON DELETE SET NULL preserves the opening record if the source lot is later hard-deleted, though lots are normally soft-deleted.';
comment on column public.box_openings.quantity is
  'How many units of the source lot were opened in this event (usually 1). Depleted from source_lot.quantity_remaining by openBox, restored by deleteBoxOpening.';
comment on column public.box_openings.transaction_id is
  'Mirrors the source lot''s primary purchase transaction, if any — kept for display only. openBox no longer creates a transaction here; the box''s cost was already deducted when it was purchased and linked as an ordinary inventory lot.';
