-- lot_cost_adjustments: costs added to an inventory lot after it was created,
-- capitalized into the lot's cost basis.
--
-- The workflow: buy a raw card, pay PSA to grade it, pay to ship it to PSA.
-- Both fees are direct costs of preparing that one identifiable card for sale,
-- so they belong in inventory cost, not in an expense line — ASC 330-10-30-1
-- (cost to bring an asset to its present location and condition) and the
-- IRC §263A costing principle. Freight-IN capitalizes; only freight-OUT to a
-- buyer stays `shipping_postage`.
--
-- Why this matters beyond correctness: expensing a grading fee to `supplies`
-- or `shipping_postage` severs it from the card, so per-item profit reports a
-- margin the card never earned. Capitalizing is what makes profitability true.
--
-- No double-deduction: Schedule C totals read from `transactions`, while
-- per-sale profitability reads from `inventory_movements` → `inventory_lots.
-- unit_cost`. The cost_of_goods transaction posted when the fee is paid is the
-- deduction; the basis increase is a reporting figure on a separate track.
-- See docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md.
--
-- Design note — `initial_unit_cost`: `unit_cost` is the all-in current basis
-- and is RECOMPUTED from the invariant on every add/remove, never mutated
-- incrementally, so repeated edits can't accumulate rounding drift:
--
--   unit_cost = (initial_unit_cost * quantity_purchased
--                + Σ active adjustment amounts) / quantity_purchased
--
-- That requires knowing the pre-adjustment basis, so we store it rather than
-- trying to infer it back out of a number adjustments have already moved.

create table public.lot_cost_adjustments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lot_id uuid not null references public.inventory_lots(id) on delete cascade,
  -- Nullable + ON DELETE SET NULL: if the funding transaction is deleted the
  -- adjustment survives, because the basis increase is still real.
  transaction_id uuid references public.transactions(id) on delete set null,
  -- True when this row posted its own cost_of_goods transaction, false when it
  -- was linked to one that already existed (e.g. a Plaid-synced PSA charge).
  -- Deleting an adjustment may only delete a transaction it created — removing
  -- a synced bank row would be destroying real financial history.
  created_transaction boolean not null default false,
  adjustment_type text not null
    check (adjustment_type in ('grading', 'shipping_to_grader', 'other')),
  amount numeric not null check (amount > 0),
  incurred_on date not null,
  grader text,
  grade_received text,
  notes text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index lot_cost_adjustments_lot_id_idx on public.lot_cost_adjustments(lot_id);
create index lot_cost_adjustments_user_id_idx on public.lot_cost_adjustments(user_id);
create index lot_cost_adjustments_transaction_id_idx on public.lot_cost_adjustments(transaction_id);

alter table public.lot_cost_adjustments enable row level security;

create policy "lot_cost_adjustments_owner_select" on public.lot_cost_adjustments
  for select using (auth.uid() = user_id);
create policy "lot_cost_adjustments_owner_insert" on public.lot_cost_adjustments
  for insert with check (auth.uid() = user_id);
create policy "lot_cost_adjustments_owner_update" on public.lot_cost_adjustments
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "lot_cost_adjustments_owner_delete" on public.lot_cost_adjustments
  for delete using (auth.uid() = user_id);

-- The lot's basis before any adjustments. Backfilled to today's unit_cost:
-- every existing lot has no adjustments, so its current cost IS its initial.
alter table public.inventory_lots add column initial_unit_cost numeric;

update public.inventory_lots set initial_unit_cost = unit_cost
where initial_unit_cost is null;

comment on table public.lot_cost_adjustments is
  'Post-creation costs capitalized into a lot''s basis (grading, shipping to grader, other). The lot''s unit_cost always reflects all-in current basis; this table is the history behind it.';
comment on column public.lot_cost_adjustments.created_transaction is
  'True if this adjustment posted its own cost_of_goods transaction. Only such transactions may be deleted when the adjustment is removed.';
comment on column public.inventory_lots.initial_unit_cost is
  'Per-unit basis at lot creation, before any lot_cost_adjustments. Lets unit_cost be recomputed from the invariant instead of mutated incrementally.';
