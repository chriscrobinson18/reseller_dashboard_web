-- box_openings: the other half of docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md
-- (grading/lot_cost_adjustments shipped 2026-07-26; this is the box-opening half).
--
-- The workflow: buy a sealed box for one price, open it, and get N individually
-- saleable cards of unequal value. NIMS (IRC §471(c)(1)(B)(ii)) says the box's
-- full cost hits Schedule C cost_of_goods on the open date, regardless of how
-- it's allocated across cards — allocation is a Profitability-dashboard/per-sale
-- number, not a Schedule C number. Per-card basis is split by the relative
-- sales value method (Treas. Reg. §1.471-2(c); ASC 330-10-30), the standard
-- approach for card/coin/comic dealers splitting a common cost across joint
-- products of unequal value.
--
-- One box_openings row is the audit trail for one open event; the resulting
-- cards are ordinary inventory_lots rows (quantity_purchased = 1 each) tagged
-- with box_opening_id, so FIFO depletion and sale flows need no changes.

create table public.box_openings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  opened_at date not null,
  box_name text not null,
  box_cost numeric not null check (box_cost > 0),
  -- Nullable + ON DELETE SET NULL: if the funding transaction is deleted the
  -- opening event survives as a record, same reasoning as lot_cost_adjustments.
  transaction_id uuid references public.transactions(id) on delete set null,
  allocation_method text not null
    check (allocation_method in ('relative_fmv', 'specific_id', 'equal')),
  notes text
);

create index box_openings_user_id_idx on public.box_openings(user_id);
create index box_openings_transaction_id_idx on public.box_openings(transaction_id);

alter table public.box_openings enable row level security;

create policy "box_openings_owner_select" on public.box_openings
  for select using (auth.uid() = user_id);
create policy "box_openings_owner_insert" on public.box_openings
  for insert with check (auth.uid() = user_id);
create policy "box_openings_owner_update" on public.box_openings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "box_openings_owner_delete" on public.box_openings
  for delete using (auth.uid() = user_id);

-- ON DELETE SET NULL (not CASCADE): deleting the opening event should not
-- silently vanish the resulting lots — same reasoning as trade_id on
-- inventory_lots. The client-side deleteBoxOpening flow soft-deletes the lots
-- itself (blocked if any have been sold), this FK is just a backstop.
alter table public.inventory_lots
  add column box_opening_id uuid references public.box_openings(id) on delete set null;

create index inventory_lots_box_opening_id_idx on public.inventory_lots(box_opening_id);

comment on table public.box_openings is
  'Audit-trail row for one sealed-box-opening event. Its cost is split across the resulting inventory_lots by relative FMV (or equal/specific-$ input), per the relative-sales-value method for joint products from a common cost. Schedule C sees the full box cost as one cost_of_goods transaction on opened_at; per-card allocation is a Profitability-only figure.';
comment on column public.inventory_lots.box_opening_id is
  'Set when this lot is a single card resulting from opening a sealed box. See box_openings.';
