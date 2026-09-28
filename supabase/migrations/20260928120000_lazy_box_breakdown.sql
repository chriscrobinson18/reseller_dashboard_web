-- Add status column to support lazy (incremental) box breakdowns.
-- 'open'   = breakdown in progress, cards being added one at a time.
-- 'closed' = finalized (all-at-once breakdowns and completed lazy ones).
alter table public.box_openings
  add column status text not null default 'open'
  check (status in ('open', 'closed'));

-- All existing breakdowns were finalized upfront -- mark them closed.
update public.box_openings
set status = 'closed'
where deleted_at is null;
