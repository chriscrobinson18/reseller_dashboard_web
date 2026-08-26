-- plaid_account_id: stable Plaid account identifier on each transaction.
-- Plaid guarantees account_id is the same for the same physical account even
-- after an item reconnect, unlike plaid_transaction_id which changes per-item.
-- Used for targeted deletion in the "Start fresh" reconnect path and for
-- grouping in the duplicate review UI (Phase C).
alter table public.transactions
  add column if not exists plaid_account_id text;

-- Backfill from plaid_metadata JSONB already stored on every Plaid row.
-- account_id is a top-level field of the raw Plaid transaction object.
update public.transactions
  set plaid_account_id = plaid_metadata->>'account_id'
  where source = 'plaid'
    and plaid_metadata is not null
    and plaid_account_id is null;

create index if not exists transactions_plaid_account_id_idx
  on public.transactions(plaid_account_id)
  where plaid_account_id is not null;

comment on column public.transactions.plaid_account_id is
  'Stable Plaid account_id (same across item reconnects for the same physical card/account). '
  'Populated on insert by plaid_sync_transactions v34+; backfilled from plaid_metadata for historical rows. '
  'Used for targeted deletion when the user chooses Start Fresh on reconnect, '
  'and for grouping in the duplicate transaction review UI.';
