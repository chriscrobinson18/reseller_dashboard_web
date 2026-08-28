-- ebay_tokens: OAuth tokens for eBay Finances API, one row per user.
-- Edge functions use service-role key to bypass RLS; users read their own row.

create table ebay_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique not null references auth.users(id) on delete cascade,
  access_token  text not null,
  refresh_token text not null,
  token_expiry  timestamptz not null,  -- access token expires 2h after mint
  last_sync_at  timestamptz,           -- null until first sync completes
  connected_at  timestamptz not null default now()
);

alter table ebay_tokens enable row level security;

create policy "Users manage own ebay tokens"
  on ebay_tokens
  for all
  using (auth.uid() = user_id);
