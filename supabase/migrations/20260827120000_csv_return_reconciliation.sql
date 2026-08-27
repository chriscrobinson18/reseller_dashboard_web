-- CSV return reconciliation: let record_return/reverse_return re-tag existing
-- CSV-imported transaction rows (the refund + return-shipping label) instead
-- of inserting new synthetic ones, and remember which rows were re-tagged so
-- reverse_return can un-tag exactly those rows rather than deleting real
-- imported financial history.
--
-- See docs/superpowers/specs/2026-07-10-returns-design.md "Proposed: the CSV
-- reconciliation layer" and docs/superpowers/specs/2026-08-27-csv-return-reconciliation-design.md.
--
-- Both columns stay null for the existing manual path (record_return inserts
-- fresh transactions there, same as before this migration).
alter table public.returns
  add column if not exists refund_transaction_id uuid references public.transactions(id) on delete set null,
  add column if not exists return_shipping_transaction_id uuid references public.transactions(id) on delete set null;

comment on column public.returns.refund_transaction_id is
  'CSV reconciliation only: the existing csv_import transactions row re-tagged as this return''s refund (schedule_c_category set to returns_allowances, related_sale_id set). Null for manual returns, which insert a fresh row instead.';
comment on column public.returns.return_shipping_transaction_id is
  'CSV reconciliation only: the existing csv_import transactions row re-tagged as this return''s return-shipping label (related_sale_id set; schedule_c_category was already shipping_postage). Null for manual returns or when no matching label row was found.';
