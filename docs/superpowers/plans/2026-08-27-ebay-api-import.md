# eBay Finances API Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace eBay CSV upload with OAuth-backed eBay Finances API integration — daily automatic sync of sales, fees, shipping labels, and refunds, managed from the Settings page.

**Architecture:** Two new Supabase edge functions (`ebay_oauth_callback` handles the OAuth redirect + initial 2-year backfill; `sync_ebay_transactions` fetches and upserts transactions). pg_cron fires `sync_ebay_transactions` daily at 4 AM UTC. Settings page replaces the eBay CSV card with a Connect / Sync Now / Disconnect UI backed by a new `ebay_tokens` table.

**Tech Stack:** Deno + Supabase Edge Functions, Supabase JS client v2, pg_cron + pg_net, React 19 + TanStack Query, eBay Finances API v1 (`apiz.ebay.com`), eBay OAuth 2.0.

> **Sandbox mode active.** Secrets are set with `EBAY_ENV=sandbox` and `VITE_EBAY_ENV=sandbox`. All edge functions and the client must derive API base URLs from this env var rather than hardcoding production domains. Sandbox domains: `api.sandbox.ebay.com` (token), `apiz.sandbox.ebay.com` (Finances API), `auth.sandbox.ebay.com` (OAuth consent).

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `supabase/migrations/20260827130000_ebay_tokens.sql` | Create | `ebay_tokens` table + RLS |
| `supabase/functions/sync_ebay_transactions/index.ts` | Create | Fetch + upsert eBay transactions (incremental + backfill) |
| `supabase/functions/ebay_oauth_callback/index.ts` | Create | OAuth code exchange, token storage, backfill trigger |
| `src/lib/queries.ts` | Modify | Add `useEbayToken()` hook |
| `src/lib/mutations.ts` | Modify | Add `getEbayAuthUrl()`, `ebaySync()`, `ebayDisconnect()` |
| `src/pages/SettingsPage.tsx` | Modify | Replace eBay CSV card with `EbayApiCard`, handle `?ebay=connected` |
| `docs/supabase-schema.md` | Modify | Document `ebay_tokens` table |

---

### Task 1: Prerequisites — register RuName and set secrets

**Files:** none (manual steps before any code)

- [ ] **Step 1: Note your Supabase project URL**

  In Supabase dashboard → Settings → API, copy the **Project URL**. Your edge function callback URL will be:
  ```
  https://<project-ref>.supabase.co/functions/v1/ebay_oauth_callback
  ```

- [ ] **Step 2: Register a RuName in eBay developer portal**

  1. Go to https://developer.ebay.com → My Account → Application Keys → your **Production** app
  2. Click **"Get a Token from eBay via Your Application"** (under User Tokens)
  3. In the "RuName" section, add a new entry with redirect URL:
     `https://<project-ref>.supabase.co/functions/v1/ebay_oauth_callback`
  4. Save and copy the generated RuName (format: `ChrisRob-ResellerD-PRD-xxxxxxx-xxxxxxxx`)

- [ ] **Step 3: Set Supabase vault secrets**

  ```bash
  supabase secrets set \
    EBAY_CLIENT_ID="SupremeD-reseller-PRD-66c1164ac-31caf214" \
    EBAY_CLIENT_SECRET="<cert-id-from-ebay-portal>" \
    EBAY_RUNAME="<runame-from-step-2>" \
    EBAY_APP_URL="https://<your-vercel-domain>"
  ```

  Verify:
  ```bash
  supabase secrets list
  ```
  Expected: All four keys appear.

- [ ] **Step 4: Add Vite env vars**

  In `.env.local` (and Vercel dashboard → Environment Variables):
  ```
  VITE_EBAY_CLIENT_ID=SupremeD-reseller-PRD-66c1164ac-31caf214
  VITE_EBAY_RUNAME=<runame-from-step-2>
  ```

---

### Task 2: Database migration — `ebay_tokens` table

**Files:**
- Create: `supabase/migrations/20260827130000_ebay_tokens.sql`

- [ ] **Step 1: Write the migration**

  ```sql
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
  ```

- [ ] **Step 2: Apply migration**

  ```bash
  supabase db push
  ```
  Expected output includes: `Applying migration 20260827130000_ebay_tokens`

- [ ] **Step 3: Verify**

  In Supabase dashboard → Table Editor → `ebay_tokens`: confirm the table exists with 7 columns.

- [ ] **Step 4: Commit**

  ```bash
  git add supabase/migrations/20260827130000_ebay_tokens.sql
  git commit -m "feat: add ebay_tokens table with RLS"
  ```

---

### Task 3: `sync_ebay_transactions` edge function

Write this before `ebay_oauth_callback` because the callback calls it.

**Files:**
- Create: `supabase/functions/sync_ebay_transactions/index.ts`

- [ ] **Step 1: Create the function**

  ```typescript
  // sync_ebay_transactions v1
  // Fetches eBay Finances API transactions and upserts into `transactions`.
  //
  // Invocation modes (from request body):
  //   { user_id, full_backfill: true }  → 2-year backfill in 90-day chunks (from ebay_oauth_callback or cron)
  //   { user_id }                        → incremental from last_sync_at - 1h (from cron)
  //   {}                                 → reads user from Bearer JWT (from Settings UI)
  //
  // Transaction mapping:
  //   SALE        → payout + commissions_fees per marketplaceFees[]
  //   SHIPPING_LABEL → shipping_postage
  //   REFUND      → payout (auto-tagged returns_allowances if matching SALE found by orderId)
  //   NON_SALE_CHARGE → commissions_fees (advertising if "promoted")
  //   ADJUSTMENT  → shipping_postage (if shipping keyword) or other_expense
  //   TRANSFER    → skipped
  //
  // Dedup key: csv_transaction_id = "ebay_api_<transactionId>" (or "_fee_<feeType>" for fees)
  // Settlement grouping: csv_group_id = payoutId

  import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
  import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const EBAY_CLIENT_ID = Deno.env.get('EBAY_CLIENT_ID')!
  const EBAY_CLIENT_SECRET = Deno.env.get('EBAY_CLIENT_SECRET')!
  const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.finances'
  const BATCH = 500

  const isSandbox = Deno.env.get('EBAY_ENV') === 'sandbox'
  const EBAY_TOKEN_URL = isSandbox
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token'
  const EBAY_API_BASE = isSandbox
    ? 'https://apiz.sandbox.ebay.com'
    : 'https://apiz.ebay.com'

  async function refreshAccessToken(
    refreshToken: string
  ): Promise<{ access_token: string; expires_in: number }> {
    const creds = btoa(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`)
    const resp = await fetch(EBAY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: EBAY_SCOPE,
      }).toString(),
    })
    if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status} ${await resp.text()}`)
    return resp.json()
  }

  // Fetch all transactions in a single ≤90-day window using offset pagination.
  async function fetchWindow(accessToken: string, from: Date, to: Date): Promise<any[]> {
    const filter = `transactionDate:[${from.toISOString()}..${to.toISOString()}]`
    const allTxs: any[] = []
    let offset = 0
    const limit = 1000

    while (true) {
      const url = new URL(`${EBAY_API_BASE}/sell/finances/v1/transaction`)
      url.searchParams.set('filter', filter)
      url.searchParams.set('limit', String(limit))
      url.searchParams.set('offset', String(offset))

      const resp = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })
      if (!resp.ok) throw new Error(`eBay API ${resp.status}: ${await resp.text()}`)

      const data = await resp.json()
      const txs: any[] = data.transactions ?? []
      allTxs.push(...txs)

      const total: number = data.total ?? 0
      offset += limit
      if (offset >= total || txs.length === 0) break
    }
    return allTxs
  }

  function feeTypeToMerchant(feeType: string): string {
    if (feeType.startsWith('FINAL_VALUE_FEE')) return 'eBay Final Value Fee'
    if (feeType.includes('PROMOTED') || feeType.includes('AD_FEE')) return 'eBay Promoted Listing Fee'
    if (feeType.includes('REGULATORY')) return 'eBay Regulatory Fee'
    return `eBay ${feeType.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}`
  }

  // Map one eBay Finances API transaction to one or more `transactions` table rows.
  function mapTransaction(tx: any, userId: string): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = []
    const date: string | undefined = (tx.transactionDate as string)?.slice(0, 10)
    if (!date) return rows

    const amount = parseFloat(tx.amount?.value ?? '0')
    const payoutId: string | null = tx.payoutId ?? null
    const orderId: string | null = tx.orderId ?? null

    const base: Record<string, unknown> = {
      user_id: userId,
      date,
      type: 'other',
      source: 'ebay_api',
      platform: 'ebay',
      record_type: 'transaction',
      csv_group_id: payoutId,
      notes: orderId,
      gross_amount: null,
      parent_settlement_id: null,
    }

    switch (tx.transactionType) {
      case 'SALE': {
        const title: string = tx.orderLineItems?.[0]?.title ?? 'eBay Sale'
        rows.push({
          ...base,
          amount,
          gross_amount: amount,
          merchant: title.slice(0, 200),
          schedule_c_category: 'payout',
          csv_transaction_id: `ebay_api_${tx.transactionId}`,
        })
        for (const item of (tx.orderLineItems ?? []) as any[]) {
          for (const fee of (item.marketplaceFees ?? []) as any[]) {
            const feeAmt = parseFloat(fee.amount?.value ?? '0')
            if (feeAmt === 0) continue
            const isAd = (fee.feeType as string)?.includes('PROMOTED') || (fee.feeType as string)?.includes('AD_FEE')
            rows.push({
              ...base,
              amount: feeAmt,
              merchant: feeTypeToMerchant(fee.feeType ?? ''),
              schedule_c_category: isAd ? 'advertising' : 'commissions_fees',
              csv_transaction_id: `ebay_api_${tx.transactionId}_fee_${fee.feeType}`,
            })
          }
        }
        break
      }
      case 'SHIPPING_LABEL':
        rows.push({
          ...base,
          amount,
          merchant: 'eBay Shipping Label',
          schedule_c_category: 'shipping_postage',
          csv_transaction_id: `ebay_api_${tx.transactionId}`,
        })
        break
      case 'REFUND': {
        const title: string = tx.orderLineItems?.[0]?.title ?? 'eBay Refund'
        rows.push({
          ...base,
          amount,
          merchant: title.slice(0, 200),
          // starts as 'payout'; autoLinkRefund re-tags to 'returns_allowances' after upsert
          schedule_c_category: 'payout',
          csv_transaction_id: `ebay_api_${tx.transactionId}`,
        })
        break
      }
      case 'NON_SALE_CHARGE': {
        const memo: string = tx.transactionMemo ?? ''
        const isAd = memo.toLowerCase().includes('promoted')
        rows.push({
          ...base,
          amount,
          merchant: memo.slice(0, 100) || 'eBay Charge',
          schedule_c_category: isAd ? 'advertising' : 'commissions_fees',
          csv_transaction_id: `ebay_api_${tx.transactionId}`,
        })
        break
      }
      case 'ADJUSTMENT': {
        const memo: string = tx.transactionMemo ?? ''
        const isShipping = /shipping|label/i.test(memo)
        rows.push({
          ...base,
          amount,
          merchant: memo.slice(0, 100) || 'eBay Adjustment',
          schedule_c_category: isShipping ? 'shipping_postage' : 'other_expense',
          csv_transaction_id: `ebay_api_${tx.transactionId}`,
        })
        break
      }
      case 'TRANSFER':
      default:
        break // skip
    }
    return rows
  }

  // Auto-link a REFUND to its matching SALE transaction by orderId.
  // Tags the refund as 'returns_allowances' and copies related_sale_id from the SALE row.
  // If no matching SALE found, still tags as 'returns_allowances' with null related_sale_id
  // so it appears in ReconcileReturnModal for manual completion.
  async function autoLinkRefund(
    supabase: ReturnType<typeof createClient>,
    userId: string,
    tx: any,
  ): Promise<void> {
    if (!tx.orderId) return

    const { data: saleTx } = await supabase
      .from('transactions')
      .select('related_sale_id')
      .eq('user_id', userId)
      .eq('notes', tx.orderId)
      .eq('schedule_c_category', 'payout')
      .eq('source', 'ebay_api')
      .maybeSingle()

    await supabase
      .from('transactions')
      .update({
        schedule_c_category: 'returns_allowances',
        related_sale_id: saleTx?.related_sale_id ?? null,
      })
      .eq('user_id', userId)
      .eq('csv_transaction_id', `ebay_api_${tx.transactionId}`)
  }

  async function syncForUser(
    supabase: ReturnType<typeof createClient>,
    userId: string,
    fullBackfill: boolean,
  ): Promise<{ windows: number; imported: number }> {
    const { data: tokenRow, error: tokenErr } = await supabase
      .from('ebay_tokens')
      .select('*')
      .eq('user_id', userId)
      .single()
    if (tokenErr || !tokenRow) throw new Error('No eBay connection for this user')

    let accessToken: string = tokenRow.access_token
    const expiry = new Date(tokenRow.token_expiry)
    if (expiry.getTime() - Date.now() < 10 * 60 * 1000) {
      console.log('Refreshing eBay access token...')
      const refreshed = await refreshAccessToken(tokenRow.refresh_token)
      accessToken = refreshed.access_token
      await supabase.from('ebay_tokens').update({
        access_token: accessToken,
        token_expiry: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      }).eq('user_id', userId)
    }

    const now = new Date()
    const windows: Array<{ from: Date; to: Date }> = []

    if (fullBackfill) {
      // Chunk 2 years into 90-day windows, oldest-first
      // NOTE: if the real API enforces a hard 90-day lookback limit (test in Task 3 Step 3),
      // change twoYearsAgo to: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
      const twoYearsAgo = new Date(now)
      twoYearsAgo.setFullYear(now.getFullYear() - 2)

      let windowEnd = new Date(now)
      while (windowEnd > twoYearsAgo) {
        const windowStart = new Date(windowEnd.getTime() - 90 * 24 * 60 * 60 * 1000)
        if (windowStart < twoYearsAgo) windowStart.setTime(twoYearsAgo.getTime())
        windows.unshift({ from: windowStart, to: new Date(windowEnd) })
        windowEnd = new Date(windowEnd.getTime() - 90 * 24 * 60 * 60 * 1000)
      }
    } else {
      const lastSync = tokenRow.last_sync_at
        ? new Date(new Date(tokenRow.last_sync_at).getTime() - 60 * 60 * 1000)
        : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      windows.push({ from: lastSync, to: now })
    }

    let totalImported = 0
    const refundTxs: any[] = []

    for (const w of windows) {
      console.log(`Fetching ${w.from.toISOString().slice(0,10)} → ${w.to.toISOString().slice(0,10)}`)
      const txs = await fetchWindow(accessToken, w.from, w.to)
      const rows: Record<string, unknown>[] = []

      for (const tx of txs) {
        rows.push(...mapTransaction(tx, userId))
        if (tx.transactionType === 'REFUND' && tx.orderId) refundTxs.push(tx)
      }

      for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await supabase
          .from('transactions')
          .upsert(rows.slice(i, i + BATCH), { onConflict: 'user_id,csv_transaction_id', ignoreDuplicates: true })
        if (error) console.error('Upsert error:', error)
      }
      totalImported += rows.length
    }

    // Auto-link all collected refunds after all windows upserted (so SALE rows exist)
    for (const tx of refundTxs) {
      await autoLinkRefund(supabase, userId, tx)
    }

    await supabase.from('ebay_tokens').update({ last_sync_at: now.toISOString() }).eq('user_id', userId)
    console.log(`Done: ${totalImported} rows, ${windows.length} windows`)
    return { windows: windows.length, imported: totalImported }
  }

  serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

    try {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )

      const body = await req.json().catch(() => ({}))
      const { user_id, full_backfill = false } = body as { user_id?: string; full_backfill?: boolean }

      let targetUserId: string
      if (user_id) {
        // Called from cron or ebay_oauth_callback with service-role key
        targetUserId = user_id
      } else {
        // Called from UI with user's JWT
        const authHeader = req.headers.get('Authorization')
        if (!authHeader) return json(401, { error: 'Missing Authorization header' })
        const { data: { user }, error } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
        if (error || !user) return json(401, { error: 'Unauthorized' })
        targetUserId = user.id
      }

      const result = await syncForUser(supabase, targetUserId, full_backfill)
      return json(200, { success: true, ...result })
    } catch (err: any) {
      console.error('sync_ebay_transactions error:', err)
      return json(500, { error: err.message ?? String(err) })
    }
  })
  ```

- [ ] **Step 2: Deploy**

  ```bash
  supabase functions deploy sync_ebay_transactions
  ```
  Expected: `Deployed Function sync_ebay_transactions`

- [ ] **Step 3: Test the 90-day historical limit**

  Temporarily generate a user access token via the eBay OAuth Playground (developer.ebay.com → My Account → User Tokens → Generate Token) then run:

  ```bash
  # Test a window from >90 days ago
  curl -s "https://apiz.ebay.com/sell/finances/v1/transaction?filter=transactionDate:[2024-06-01T00:00:00.000Z..2024-08-01T00:00:00.000Z]&limit=5" \
    -H "Authorization: Bearer <access-token>" | jq '{total: .total, count: (.transactions | length)}'
  ```

  - **If `total > 0`**: historical access works — 2-year backfill will succeed as written.
  - **If `total = 0` despite known transactions**: hard 90-day limit confirmed. In `syncForUser`, change:
    ```typescript
    twoYearsAgo.setFullYear(now.getFullYear() - 2)
    ```
    to:
    ```typescript
    twoYearsAgo.setTime(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    ```
    Then redeploy: `supabase functions deploy sync_ebay_transactions`

- [ ] **Step 4: Commit**

  ```bash
  git add supabase/functions/sync_ebay_transactions/
  git commit -m "feat: add sync_ebay_transactions edge function"
  ```

---

### Task 4: `ebay_oauth_callback` edge function

**Files:**
- Create: `supabase/functions/ebay_oauth_callback/index.ts`

- [ ] **Step 1: Create the function**

  ```typescript
  // ebay_oauth_callback v1
  // Handles the eBay OAuth 2.0 authorization code redirect.
  //
  // Flow:
  //   1. Validates ?state param as user JWT → identifies user
  //   2. Exchanges ?code for access_token + refresh_token
  //   3. Upserts into ebay_tokens
  //   4. Hard-deletes all source='csv_import' + platform='ebay' rows for this user
  //   5. Fires sync_ebay_transactions with full_backfill=true (background, non-blocking)
  //   6. Redirects browser to <EBAY_APP_URL>/settings?ebay=connected

  import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
  import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

  const EBAY_CLIENT_ID = Deno.env.get('EBAY_CLIENT_ID')!
  const EBAY_CLIENT_SECRET = Deno.env.get('EBAY_CLIENT_SECRET')!
  const EBAY_RUNAME = Deno.env.get('EBAY_RUNAME')!
  const EBAY_APP_URL = Deno.env.get('EBAY_APP_URL')!
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const isSandbox = Deno.env.get('EBAY_ENV') === 'sandbox'
  const EBAY_TOKEN_URL = isSandbox
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token'

  function redirect(url: string) {
    return new Response(null, { status: 302, headers: { Location: url } })
  }

  serve(async (req) => {
    try {
      const url = new URL(req.url)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state') // user's JWT

      if (!code || !state) {
        return redirect(`${EBAY_APP_URL}/settings?ebay=error&reason=missing_params`)
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

      // Validate state = user JWT
      const { data: { user }, error: authError } = await supabase.auth.getUser(state)
      if (authError || !user) {
        console.error('OAuth state validation failed:', authError?.message)
        return redirect(`${EBAY_APP_URL}/settings?ebay=error&reason=invalid_state`)
      }

      // Exchange code for tokens
      const creds = btoa(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`)
      const tokenResp = await fetch(EBAY_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: EBAY_RUNAME,
        }).toString(),
      })

      if (!tokenResp.ok) {
        console.error('Token exchange failed:', tokenResp.status, await tokenResp.text())
        return redirect(`${EBAY_APP_URL}/settings?ebay=error&reason=token_exchange_failed`)
      }

      const { access_token, refresh_token, expires_in } = await tokenResp.json()

      // Store tokens
      const { error: upsertError } = await supabase.from('ebay_tokens').upsert({
        user_id: user.id,
        access_token,
        refresh_token,
        token_expiry: new Date(Date.now() + expires_in * 1000).toISOString(),
        last_sync_at: null,
        connected_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })

      if (upsertError) {
        console.error('Token upsert failed:', upsertError.message)
        return redirect(`${EBAY_APP_URL}/settings?ebay=error&reason=storage_failed`)
      }

      // Hard-delete existing eBay CSV transactions
      const { error: deleteError, count } = await supabase
        .from('transactions')
        .delete({ count: 'exact' })
        .eq('user_id', user.id)
        .eq('source', 'csv_import')
        .eq('platform', 'ebay')
      if (deleteError) console.error('CSV delete error (non-fatal):', deleteError.message)
      else console.log(`Deleted ${count} eBay CSV rows for user ${user.id}`)

      // Fire backfill in background (non-blocking)
      const backfillPromise = fetch(`${SUPABASE_URL}/functions/v1/sync_ebay_transactions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: user.id, full_backfill: true }),
      }).then(r => console.log('Backfill triggered, status:', r.status))
        .catch(e => console.error('Backfill trigger error:', e))

      // Keep backfill alive after response returns
      if (typeof (globalThis as any).EdgeRuntime !== 'undefined') {
        ;(globalThis as any).EdgeRuntime.waitUntil(backfillPromise)
      }

      return redirect(`${EBAY_APP_URL}/settings?ebay=connected`)
    } catch (err: any) {
      console.error('ebay_oauth_callback error:', err)
      return redirect(`${EBAY_APP_URL}/settings?ebay=error&reason=unexpected`)
    }
  })
  ```

- [ ] **Step 2: Deploy**

  ```bash
  supabase functions deploy ebay_oauth_callback
  ```
  Expected: `Deployed Function ebay_oauth_callback`

- [ ] **Step 3: Commit**

  ```bash
  git add supabase/functions/ebay_oauth_callback/
  git commit -m "feat: add ebay_oauth_callback edge function"
  ```

---

### Task 5: Client mutations and queries

**Files:**
- Modify: `src/lib/queries.ts`
- Modify: `src/lib/mutations.ts`

- [ ] **Step 1: Add `useEbayToken` to `src/lib/queries.ts`**

  Add after the last existing query hook in the file:

  ```typescript
  export function useEbayToken() {
    return useQuery({
      queryKey: ['ebay_token'],
      queryFn: async () => {
        const { data, error } = await supabase
          .from('ebay_tokens')
          .select('user_id, last_sync_at, connected_at')
          .maybeSingle()
        if (error) throw error
        return data // null = not connected
      },
    })
  }
  ```

- [ ] **Step 2: Add eBay functions to `src/lib/mutations.ts`**

  Add after the last existing export in the file:

  ```typescript
  export function getEbayAuthUrl(accessToken: string): string {
    const isSandbox = (import.meta.env.VITE_EBAY_ENV as string) === 'sandbox'
    const authBase = isSandbox ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com'
    const params = new URLSearchParams({
      client_id: import.meta.env.VITE_EBAY_CLIENT_ID as string,
      redirect_uri: import.meta.env.VITE_EBAY_RUNAME as string,
      response_type: 'code',
      scope: 'https://api.ebay.com/oauth/api_scope/sell.finances',
      state: accessToken,
    })
    return `${authBase}/oauth2/authorize?${params.toString()}`
  }

  export async function ebaySync(): Promise<{ imported: number; windows: number }> {
    const resp = await supabase.functions.invoke('sync_ebay_transactions', { body: {} })
    if (resp.error) throw new Error(resp.error.message)
    return resp.data
  }

  export async function ebayDisconnect(): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Not authenticated')
    const { error } = await supabase.from('ebay_tokens').delete().eq('user_id', user.id)
    if (error) throw error
  }
  ```

- [ ] **Step 3: Build to verify no TypeScript errors**

  ```bash
  npm run build
  ```
  Expected: Completes without errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/queries.ts src/lib/mutations.ts
  git commit -m "feat: add useEbayToken query and eBay sync/disconnect mutations"
  ```

---

### Task 6: Settings UI — eBay API card

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add imports**

  In `src/pages/SettingsPage.tsx`, add to the existing imports:

  ```typescript
  import { supabase } from '../lib/supabase'
  import { useEbayToken } from '../lib/queries'
  import { getEbayAuthUrl, ebaySync, ebayDisconnect } from '../lib/mutations'
  ```

- [ ] **Step 2: Add `?ebay=connected` / `?ebay=error` URL handler**

  Inside the `SettingsPage` component body, add this effect after the existing `useEffect` calls:

  ```typescript
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const ebayStatus = params.get('ebay')
    if (ebayStatus === 'connected' || ebayStatus === 'error') {
      window.history.replaceState({}, '', window.location.pathname)
      setActiveTab('imports')
      if (ebayStatus === 'error') {
        const reason = params.get('reason') ?? 'unknown'
        console.error('eBay OAuth error:', reason)
        // surface to user if you have a general error state, otherwise check logs
      }
    }
  }, [])
  ```

- [ ] **Step 3: Add `EbayApiCard` component**

  Add this component definition at the bottom of `SettingsPage.tsx`, alongside the existing `CSVImportCard` function:

  ```typescript
  function EbayApiCard() {
    const { data: token, isLoading, refetch } = useEbayToken()
    const qc = useQueryClient()
    const [syncing, setSyncing] = useState(false)
    const [syncError, setSyncError] = useState<string | null>(null)

    async function handleConnect() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      window.location.href = getEbayAuthUrl(session.access_token)
    }

    async function handleSync() {
      setSyncing(true)
      setSyncError(null)
      try {
        await ebaySync()
        await refetch()
        qc.invalidateQueries({ queryKey: ['transactions'] })
      } catch (e: unknown) {
        setSyncError(e instanceof Error ? e.message : 'Sync failed')
      } finally {
        setSyncing(false)
      }
    }

    async function handleDisconnect() {
      if (!confirm('Disconnect eBay? Your synced transactions will be kept.')) return
      try {
        await ebayDisconnect()
        await refetch()
      } catch (e: unknown) {
        console.error('Disconnect error:', e)
      }
    }

    if (isLoading) return (
      <div className="p-4 text-sm text-gray-500">Loading eBay connection...</div>
    )

    const connected = token !== null

    return (
      <div className="p-4 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900 text-sm">eBay</span>
            {connected && (
              <span className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
                ✓ Connected
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {connected
              ? token.last_sync_at
                ? `Last synced ${new Date(token.last_sync_at).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                  })}`
                : 'Initial sync in progress…'
              : 'Sync sales, fees, and payouts automatically via eBay Finances API'}
          </div>
          {syncError && (
            <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
              {syncError}
            </div>
          )}
        </div>

        {connected ? (
          <div className="flex gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
            <button
              type="button"
              onClick={handleDisconnect}
              className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleConnect}
            className="flex-shrink-0 text-xs px-3 py-1.5 rounded bg-gray-900 text-white hover:bg-gray-700"
          >
            Connect eBay →
          </button>
        )}
      </div>
    )
  }
  ```

- [ ] **Step 4: Replace eBay CSV card with `EbayApiCard`**

  In the `{activeTab === 'imports' && ...}` block, find the `<CSVImportCard platform="ebay" .../>` element and replace it with:

  ```tsx
  <EbayApiCard />
  ```

- [ ] **Step 5: Update section heading and tab label**

  Find and replace the `<h2>` heading:
  ```tsx
  <h2 className="text-lg font-semibold text-gray-900">Marketplace CSV Import</h2>
  ```
  Replace with:
  ```tsx
  <h2 className="text-lg font-semibold text-gray-900">Marketplace</h2>
  ```

  Also find the `TABS` array (near the top of SettingsPage.tsx). The entry with `id: 'imports'` will have a label like `'Marketplace CSV'` or `'Imports'`. Update its label to `'Marketplace'`.

- [ ] **Step 6: Remove unused eBay CSV state and ref**

  Remove these two lines from the `SettingsPage` component body:
  ```typescript
  const [ebayState, setEbayState] = useState<ImportState>({ phase: 'idle' })
  const ebayRef = useRef<HTMLInputElement>(null)
  ```
  Leave Amazon and Mercari equivalents. `ImportState` type stays — Amazon and Mercari still use it.

- [ ] **Step 7: Build to verify**

  ```bash
  npm run build
  ```
  Expected: No TypeScript errors.

- [ ] **Step 8: Commit**

  ```bash
  git add src/pages/SettingsPage.tsx
  git commit -m "feat: add eBay API Connect card to Settings, replace CSV card"
  ```

---

### Task 7: pg_cron daily schedule

Run once in Supabase SQL editor after both edge functions are deployed and end-to-end connect works.

**Files:** none (manual SQL)

- [ ] **Step 1: Run the cron schedule**

  In Supabase dashboard → SQL editor:

  ```sql
  -- Replace <project-ref> and <service-role-key> with real values before running.
  select cron.schedule(
    'sync-ebay-daily',
    '0 4 * * *',
    $$
      select net.http_post(
        url := 'https://<project-ref>.supabase.co/functions/v1/sync_ebay_transactions',
        headers := jsonb_build_object(
          'Authorization', 'Bearer <service-role-key>',
          'Content-Type', 'application/json'
        ),
        body := json_build_object('user_id', user_id)::jsonb
      )
      from ebay_tokens;
    $$
  );
  ```

- [ ] **Step 2: Verify registration**

  ```sql
  select jobname, schedule, active from cron.job where jobname = 'sync-ebay-daily';
  ```
  Expected: 1 row, `active = true`.

- [ ] **Step 3: Document the table in `docs/supabase-schema.md`**

  Find the section for the `expenses` or `ebay` area and add:

  ```markdown
  ## `ebay_tokens`

  Stores eBay Finances API OAuth tokens per user (one row per user). Created by `ebay_oauth_callback`, read and refreshed by `sync_ebay_transactions`.

  | Column | Type | Notes |
  |---|---|---|
  | `id` | uuid PK | |
  | `user_id` | uuid FK → auth.users | unique; one eBay connection per user |
  | `access_token` | text | Expires in 2h; auto-refreshed within 10 min of expiry |
  | `refresh_token` | text | Expires in ~18 months; re-OAuth required when expired |
  | `token_expiry` | timestamptz | Expiry of current access_token |
  | `last_sync_at` | timestamptz | Null until first sync; used as `from` boundary minus 1h for incremental syncs |
  | `connected_at` | timestamptz | First OAuth connect timestamp |

  **RLS:** users read/write own row. Edge functions use service-role key.
  **pg_cron:** `sync-ebay-daily` — fires 4 AM UTC, one HTTP POST per connected user.
  **Related edge functions:** `ebay_oauth_callback` (write), `sync_ebay_transactions` (read/write).
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add docs/supabase-schema.md
  git commit -m "docs: document ebay_tokens table and pg_cron sync job"
  ```

---

### Task 8: End-to-end verification

- [ ] **Step 1: Start dev server and navigate to Settings**

  ```bash
  npm run dev
  ```
  Open `/settings` → Marketplace tab. Expected: eBay card shows "Connect eBay →".

- [ ] **Step 2: Complete OAuth flow**

  Click "Connect eBay →". You should be redirected to `auth.ebay.com`. After granting permission, you should land back on `/settings` with the eBay card showing "✓ Connected" and "Initial sync in progress…".

  If you land on `?ebay=error`: check edge function logs in Supabase dashboard → Edge Functions → `ebay_oauth_callback` → Logs.

- [ ] **Step 3: Verify tokens stored**

  Supabase dashboard → Table Editor → `ebay_tokens`: confirm a row exists with non-null `access_token` and `refresh_token`.

- [ ] **Step 4: Verify transactions imported**

  Supabase → `transactions` table: filter `source = ebay_api`. Confirm rows exist with:
  - `platform = ebay`
  - `csv_group_id` = a payout ID (non-null for SALEs with payouts)
  - `notes` = an order ID
  - `schedule_c_category` one of: `payout`, `commissions_fees`, `shipping_postage`, `advertising`, `returns_allowances`

- [ ] **Step 5: Verify old CSV rows deleted**

  Filter `transactions` by `source = csv_import` AND `platform = ebay`. Expected: 0 rows.

- [ ] **Step 6: Check 90-day limit result (from Task 3 Step 3)**

  In edge function logs for `sync_ebay_transactions`, look for the window log lines. If windows older than 90 days return 0 rows despite known transaction history, apply the fix from Task 3 Step 3 and redeploy.

- [ ] **Step 7: Test "Sync Now"**

  Click "Sync Now". Expected: spinner shows, completes, "Last synced" timestamp updates. Confirm no duplicate rows in `transactions`.

- [ ] **Step 8: Test "Disconnect"**

  Click "Disconnect". Expected: card returns to "Connect eBay →" state. `ebay_tokens` row deleted. Transaction history remains in `transactions`.
