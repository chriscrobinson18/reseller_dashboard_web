// ebay_oauth_callback v2
// Handles the eBay OAuth 2.0 authorization code redirect.
//
// Flow:
//   1. Validates ?state param as user JWT → identifies user
//   2. Exchanges ?code for access_token + refresh_token
//   3. Fetches eBay userId via Identity API → stores in ebay_tokens.ebay_user_id
//   4. Upserts into ebay_tokens
//   5. Hard-deletes all source='csv_import' + platform='ebay' rows for this user
//   6. Fires sync_ebay_transactions with full_backfill=true (background, non-blocking)
//   7. Redirects browser to <EBAY_APP_URL>/settings?ebay=connected

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
const EBAY_IDENTITY_URL = isSandbox
  ? 'https://apiz.sandbox.ebay.com/commerce/identity/v1/user/'
  : 'https://apiz.ebay.com/commerce/identity/v1/user/'

function redirect(url: string) {
  return new Response(null, { status: 302, headers: { Location: url } })
}

serve(async (req) => {
  try {
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state') // user's JWT (access token); validates identity. MVP approach — for production hardening, use a HMAC-signed nonce instead.

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

    if (!access_token || !refresh_token || typeof expires_in !== 'number') {
      console.error('Unexpected token response shape', { has_access: !!access_token, has_refresh: !!refresh_token, expires_in })
      return redirect(`${EBAY_APP_URL}/settings?ebay=error&reason=token_exchange_failed`)
    }

    // Fetch eBay userId for account deletion mapping (non-fatal if fails)
    let ebayUserId: string | null = null
    try {
      const idResp = await fetch(EBAY_IDENTITY_URL, {
        headers: { 'Authorization': `Bearer ${access_token}` },
      })
      if (idResp.ok) {
        const idData = await idResp.json()
        ebayUserId = idData.userId ?? null
        console.log('eBay userId:', ebayUserId)
      } else {
        console.error('Identity API failed (non-fatal):', idResp.status, await idResp.text())
      }
    } catch (e) {
      console.error('Identity API error (non-fatal):', e)
    }

    // Store tokens
    const { error: upsertError } = await supabase.from('ebay_tokens').upsert({
      user_id: user.id,
      access_token,
      refresh_token,
      token_expiry: new Date(Date.now() + expires_in * 1000).toISOString(),
      connected_at: new Date().toISOString(),
      ...(ebayUserId ? { ebay_user_id: ebayUserId } : {}),
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
