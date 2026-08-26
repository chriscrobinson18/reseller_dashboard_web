// plaid_exchange_token v17
// v17: Plaid best-practices duplicate prevention (see docs/superpowers/specs/2026-08-25-plaid-dedup-design.md).
//
// CREATE MODE (default): Before exchanging, check if any incoming account_ids from the
// Plaid onSuccess metadata already exist in plaid_accounts for this user. If so, return
// { status: 'duplicate_detected' } without touching Plaid — the client shows a Keep/Fresh
// modal, then sends a second call with choice + existing_item_id.
//   keep  → discard public token, return existing item info (no exchange, no new item)
//   fresh → hard-delete old transactions by plaid_account_id, revoke old item, exchange new token
//
// UPDATE MODE (mode='update'): Skip duplicate detection. Exchange token to confirm re-auth
// with Plaid, then reset plaid_items.status='active' and clear error_message. Closes the P1
// gap where a successful update-mode reconnect left the badge stuck on "Reconnect needed".
//
// v16's institution-id-based auto-replace is removed. User choice replaces silent replacement.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { Configuration, PlaidApi, PlaidEnvironments, CountryCode } from "npm:plaid@latest"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[Deno.env.get('PLAID_ENV') || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': Deno.env.get('PLAID_CLIENT_ID'),
      'PLAID-SECRET': Deno.env.get('PLAID_SECRET'),
    },
  },
})

const plaidClient = new PlaidApi(plaidConfig)

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')!
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) return jsonResponse({ error: 'Unauthorized' }, 401)

    const body = await req.json()
    const {
      public_token,
      metadata,
      mode = 'create',
      item_id,
      choice,
      existing_item_id,
    } = body

    // ── UPDATE MODE ────────────────────────────────────────────────────────────
    // User completed Link update-mode to re-authenticate an existing item.
    // Exchange confirms re-auth with Plaid; access_token may rotate at some institutions.
    if (mode === 'update') {
      if (!public_token || !item_id) {
        return jsonResponse({ error: 'public_token and item_id required for update mode' }, 400)
      }
      const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token })
      const accessToken = exchangeResponse.data.access_token

      const { error: updateError } = await supabase
        .from('plaid_items')
        .update({ status: 'active', error_message: null, access_token: accessToken })
        .eq('item_id', item_id)
        .eq('user_id', user.id)
      if (updateError) throw new Error(`Failed to update item status: ${updateError.message}`)

      console.log('Update-mode reconnect: status reset to active for item', item_id)
      return jsonResponse({ success: true, status: 'reconnected' })
    }

    // ── CREATE MODE ────────────────────────────────────────────────────────────
    if (!public_token) return jsonResponse({ error: 'public_token required' }, 400)

    // Phase 1: Keep — return existing item info without exchanging the token.
    if (choice === 'keep') {
      if (!existing_item_id) return jsonResponse({ error: 'existing_item_id required' }, 400)
      const { data: existingItem } = await supabase
        .from('plaid_items')
        .select('status, institution_name')
        .eq('item_id', existing_item_id)
        .eq('user_id', user.id)
        .maybeSingle()

      const loginRequired = existingItem?.status === 'login_required'
      console.log('User chose Keep for existing item', existing_item_id)
      return jsonResponse({
        status: 'kept',
        institution_name: existingItem?.institution_name ?? null,
        ...(loginRequired ? {
          warning: 'login_required',
          message: 'Your existing connection needs re-authentication. Use the Reconnect button.',
        } : {}),
      })
    }

    // Phase 2: Fresh — delete old transactions, revoke old item, then fall through to exchange.
    if (choice === 'fresh') {
      if (!existing_item_id) return jsonResponse({ error: 'existing_item_id required' }, 400)

      // Collect old account_ids for targeted transaction deletion.
      const { data: oldAccounts } = await supabase
        .from('plaid_accounts')
        .select('account_id')
        .eq('item_id', existing_item_id)
        .eq('user_id', user.id)
      const oldAccountIds = (oldAccounts ?? []).map((a: any) => a.account_id)

      // Hard-delete — consistent with plaid_sync_transactions removal behavior (no soft-delete).
      if (oldAccountIds.length > 0) {
        const { error: delErr } = await supabase
          .from('transactions')
          .delete()
          .in('plaid_account_id', oldAccountIds)
          .eq('user_id', user.id)
        if (delErr) console.warn('Transaction deletion error (non-fatal):', delErr.message)
        console.log(`Deleted transactions for ${oldAccountIds.length} account(s) in item ${existing_item_id}`)
      }

      // Revoke the old Plaid item and remove its DB rows.
      const { data: oldItem } = await supabase
        .from('plaid_items')
        .select('access_token')
        .eq('item_id', existing_item_id)
        .eq('user_id', user.id)
        .maybeSingle()
      if (oldItem) {
        try {
          await plaidClient.itemRemove({ access_token: oldItem.access_token })
        } catch (removeErr: any) {
          console.warn('Could not revoke old Plaid item (non-fatal):', removeErr?.message)
        }
        await supabase.from('plaid_accounts').delete().eq('item_id', existing_item_id)
        await supabase.from('plaid_items').delete().eq('item_id', existing_item_id)
      }
      // Fall through to exchange + create new item below.
    }

    // Phase 0: First call (no choice yet) — pre-exchange duplicate detection.
    // account_id is stable across reconnects; if it already exists in plaid_accounts
    // for this user, this is a reconnect of an existing account, not a new connection.
    if (choice === undefined) {
      const incomingAccountIds: string[] = (metadata?.accounts ?? [])
        .map((a: any) => a.id)
        .filter(Boolean)

      if (incomingAccountIds.length > 0) {
        const { data: existingAccounts } = await supabase
          .from('plaid_accounts')
          .select('account_id, mask, item_id')
          .in('account_id', incomingAccountIds)
          .eq('user_id', user.id)

        if (existingAccounts && existingAccounts.length > 0) {
          const existingItemId = existingAccounts[0].item_id
          const { data: existingItem } = await supabase
            .from('plaid_items')
            .select('institution_name, status')
            .eq('item_id', existingItemId)
            .eq('user_id', user.id)
            .maybeSingle()

          console.log('Duplicate detected — account_ids already connected:', incomingAccountIds)
          return jsonResponse({
            status: 'duplicate_detected',
            existing_item_id: existingItemId,
            existing_institution_name:
              existingItem?.institution_name ?? metadata?.institution?.name ?? 'this institution',
            matched_masks: existingAccounts.map((a: any) => `••${a.mask}`),
            existing_item_status: existingItem?.status ?? 'active',
          })
        }
      }
      // No duplicate — fall through to exchange.
    }

    // ── EXCHANGE + CREATE NEW ITEM ─────────────────────────────────────────────
    // Reached when: no duplicate found (phase 0) OR user chose fresh (phase 2).
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token })
    const accessToken = exchangeResponse.data.access_token
    const itemId = exchangeResponse.data.item_id
    console.log('Token exchanged for item:', itemId)

    let institutionId: string | null = null
    let institutionName: string | null = null
    try {
      const itemResp = await plaidClient.itemGet({ access_token: accessToken })
      institutionId = itemResp.data.item.institution_id ?? null
      if (institutionId) {
        const instResp = await plaidClient.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
        })
        institutionName = instResp.data.institution.name
        console.log('Institution:', institutionName, institutionId)
      }
    } catch (instErr: any) {
      console.warn('Could not fetch institution info (non-fatal):', instErr?.message)
    }

    const { error: upsertError } = await supabase.from('plaid_items').upsert({
      user_id: user.id,
      item_id: itemId,
      access_token: accessToken,
      institution_id: institutionId,
      institution_name: institutionName,
      cursor: null,
      last_synced_at: null,
    }, { onConflict: 'item_id' })
    if (upsertError) throw new Error(`Failed to store item: ${upsertError.message}`)
    console.log('Item stored:', itemId)

    try {
      const acctResp = await plaidClient.accountsGet({ access_token: accessToken })
      for (const acct of acctResp.data.accounts) {
        const subtype = acct.subtype ?? acct.type ?? 'account'
        const displayName = `${subtype.charAt(0).toUpperCase() + subtype.slice(1)} ••${acct.mask}`
        await supabase.from('plaid_accounts').upsert({
          user_id: user.id,
          item_id: itemId,
          account_id: acct.account_id,
          name: acct.name,
          mask: acct.mask,
          subtype: acct.subtype ?? acct.type,
          display_name: displayName,
        }, { onConflict: 'account_id', ignoreDuplicates: false })
      }
      console.log(`Stored ${acctResp.data.accounts.length} accounts`)
    } catch (acctErr: any) {
      console.warn('Could not store accounts (non-fatal):', acctErr?.message)
    }

    return jsonResponse({
      success: true,
      institution_name: institutionName,
      note: 'Account connected. Transactions will sync automatically within 24 hours, or tap Sync Now in Settings.',
    })

  } catch (error: any) {
    console.error('Exchange token error:', error?.response?.data ?? error?.message)
    return jsonResponse({ error: error.message }, 500)
  }
})
