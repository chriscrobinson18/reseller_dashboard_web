# eBay Finances API Import — Design Spec

**Date:** 2026-08-27
**Status:** Approved
**Replaces:** eBay CSV upload (Transaction Report)

## Problem

Neither eBay CSV export solves both requirements simultaneously:

- **Transaction Report** — has Payout ID (settlement matching works) but bulk shipping labels show as "US_MIXED for N orders" with no per-order breakdown
- **Order Earnings** — has per-order shipping attribution but no Payout ID (settlement matching broken)

The eBay Finances API provides both: per-order fees + shipping + refunds linked to order ID AND to payout/settlement ID.

## Decision

Replace eBay CSV upload with eBay Finances API integration. CSV upload cards for Amazon and Mercari remain unchanged.

---

## Architecture: Two Edge Functions + pg_cron

**Option chosen:** Two focused edge functions (matches existing `plaid_exchange_token` + `plaid_sync_transactions` pattern).

1. `ebay_oauth_callback` — OAuth code exchange, token storage, initial backfill trigger
2. `sync_ebay_transactions` — incremental transaction fetch + upsert, called by cron and UI

---

## Data Model

### New table: `ebay_tokens`

```sql
create table ebay_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique not null references auth.users(id) on delete cascade,
  access_token  text not null,
  refresh_token text not null,
  token_expiry  timestamptz not null,
  last_sync_at  timestamptz,
  connected_at  timestamptz not null default now()
);

-- RLS
alter table ebay_tokens enable row level security;
create policy "Users manage own ebay tokens"
  on ebay_tokens for all using (auth.uid() = user_id);
```

RLS allows users to read their own connection status. Edge functions use service-role key for token reads/writes.

### `transactions` table — no schema changes

API rows use existing columns:
- `source = 'ebay_api'`
- `platform = 'ebay'`
- `csv_transaction_id` = dedup key (e.g. `ebay_api_<transactionId>`)
- `csv_group_id` = payout ID (settlement grouping)
- `notes` = order ID

---

## OAuth Flow

### Secrets (stored in Supabase vault)

- `EBAY_CLIENT_ID` — App ID / Client ID
- `EBAY_CLIENT_SECRET` — Cert ID / Client Secret
- `EBAY_RUNAME` — Registered redirect URI name in eBay developer portal (required by eBay; maps to the edge function callback URL)

### Flow

1. User clicks "Connect eBay" in Settings
2. Client generates authorization URL and redirects user to eBay:
   ```
   https://auth.ebay.com/oauth2/authorize
     ?client_id=<EBAY_CLIENT_ID>
     &redirect_uri=<EBAY_RUNAME>
     &response_type=code
     &scope=https://api.ebay.com/oauth/api_scope/sell.finances
     &state=<user JWT for CSRF protection>
   ```
3. User grants permission on eBay's consent page
4. eBay redirects to `https://<project>.supabase.co/functions/v1/ebay_oauth_callback?code=...&state=...`

### `ebay_oauth_callback` edge function

1. Validate `state` against the user's session token
2. POST to eBay token endpoint to exchange `code` → `access_token` + `refresh_token`
3. Upsert into `ebay_tokens` for the user
4. Hard-delete existing `transactions` rows where `source = 'csv_import' AND platform = 'ebay'` for this user
5. Call `sync_ebay_transactions` with `full_backfill = true` (2-year window)
6. Redirect browser to `https://<app-url>/settings?ebay=connected`

---

## `sync_ebay_transactions` Edge Function

### Invocation modes

| Mode | Trigger | Date range |
|---|---|---|
| Initial backfill | Called from `ebay_oauth_callback` with `full_backfill=true` | now - 2 years → now |
| Incremental | pg_cron daily at 4 AM UTC | `last_sync_at - 1 hour` → now |
| Manual | "Sync Now" button in Settings | `last_sync_at - 1 hour` → now |

The 1-hour overlap handles eBay API eventual consistency. Duplicate rows are silently skipped via `ignoreDuplicates: true` on upsert.

### Token refresh

Before fetching: if `token_expiry` is within 10 minutes, POST to eBay token endpoint with `refresh_token`, update `ebay_tokens`.

### API endpoint

```
GET https://api.ebay.com/sell/finances/v1/transaction
  ?transactionDateRange.from=<ISO8601>
  &transactionDateRange.to=<ISO8601>
  &limit=200
```

Paginate via `next` cursor until exhausted.

### Transaction mapping

| eBay `transactionType` | merchant | `schedule_c_category` | dedup key suffix |
|---|---|---|---|
| `SALE` (gross amount) | item title or "eBay Sale" | `payout` | `<transactionId>` |
| `SALE` fee (per `marketplaceFees[]`) | "eBay Final Value Fee" / fee type | `commissions_fees` | `<transactionId>_fee_<feeType>` |
| `SHIPPING_LABEL` | "eBay Shipping Label" | `shipping_postage` | `<transactionId>` |
| `REFUND` | item title or "eBay Refund" | `payout` | `<transactionId>` |
| `NON_SALE_CHARGE` | description | `commissions_fees` (or `advertising` if promoted) | `<transactionId>` |
| `ADJUSTMENT` | description | `shipping_postage` or `other_expense` | `<transactionId>` |
| `TRANSFER` | — | skip | — |

All dedup keys prefixed: `ebay_api_<suffix>`

### Return auto-linking

When a `REFUND` transaction is imported:
1. Extract order ID from `transaction.orderId` (top-level field on Finances API REFUND response)
2. Look up existing `transactions` row where `notes = <orderId>` and `schedule_c_category = 'payout'` and `source = 'ebay_api'`
3. If found, call `record_return` logic to link the refund to the sale (sets `refund_transaction_id` on the matching `returns` row if one exists, or creates a new return record)
4. If no matching sale found, import the REFUND as-is without auto-linking; it appears in `ReconcileReturnModal` for manual review

This eliminates manual reconciliation for eBay API refunds in the common case. `ReconcileReturnModal` remains for Amazon and Mercari CSV returns, and for any eBay refunds where the original sale isn't found.

### After sync

Update `ebay_tokens.last_sync_at = now()`.

### pg_cron schedule

```sql
select cron.schedule(
  'sync-ebay-daily',
  '0 4 * * *',  -- 4 AM UTC daily
  $$
    select net.http_post(
      url := '<supabase-project-url>/functions/v1/sync_ebay_transactions',
      headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb,
      body := json_build_object('user_id', user_id)::jsonb
    )
    from ebay_tokens;  -- one HTTP call per connected user row
  $$
);
```

The cron query selects from `ebay_tokens` and fires one HTTP POST per row, passing `user_id` in the body so the edge function knows which user to sync.

---

## Settings UI

**Tab:** existing "Marketplace CSV" tab — rename to "Marketplace" (since eBay is now API-based, not CSV)

### Not connected state

```
┌─────────────────────────────────────────┐
│  [eBay logo]  eBay                      │
│  Sync sales, fees, and payouts          │
│  automatically via eBay Finances API    │
│                                         │
│  [ Connect eBay → ]                     │
└─────────────────────────────────────────┘
```

### Connected state

```
┌─────────────────────────────────────────┐
│  [eBay logo]  eBay  ✓ Connected         │
│  Last synced: Aug 27, 2026 at 4:00 AM  │
│                                         │
│  [ Sync Now ]        [ Disconnect ]     │
└─────────────────────────────────────────┘
```

- **Sync Now** — calls `sync_ebay_transactions`, shows spinner, updates "Last synced" on completion
- **Disconnect** — deletes `ebay_tokens` row; does NOT delete transaction history

---

## What's Kept / Removed

| | Before | After |
|---|---|---|
| eBay data source | CSV upload (manual) | Finances API (automatic) |
| eBay CSV card in Settings | ✓ present | Replaced by "Connect eBay" card |
| Amazon CSV | ✓ | ✓ unchanged |
| Mercari CSV | ✓ | ✓ unchanged |
| Existing eBay CSV rows | present | Hard-deleted on first OAuth connect |
| eBay return reconciliation | Manual via ReconcileReturnModal | Auto-linked on import |

---

## Out of Scope

- Sandbox/testing environment (production credentials only)
- Backfill beyond 2 years (eBay API limitation)
- eBay Order API or inventory sync
- Multiple eBay accounts per user
