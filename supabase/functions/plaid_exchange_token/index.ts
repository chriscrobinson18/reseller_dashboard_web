// plaid_exchange_token v16
// CORS: handles OPTIONS preflight and returns Access-Control-Allow-Origin on every
// response so the web client (browser) can call this function. iOS native HTTPS
// callers ignore these headers — additive change, no behavioral impact for mobile.
// Exchanges public token, stores item + institution name + accounts.
// Deduplicates by institution_id — if the user already has a connection to the
// same institution, the old item is replaced (old Plaid item revoked + row updated)
// rather than creating a second row.
// No initial transaction fetch — the daily cron handles first history pull (cursor=null).
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { public_token } = await req.json()
    if (!public_token) {
      return new Response(
        JSON.stringify({ error: 'public_token required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

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

    if (institutionId) {
      const { data: existing } = await supabase
        .from('plaid_items')
        .select('item_id, access_token')
        .eq('user_id', user.id)
        .eq('institution_id', institutionId)
        .neq('item_id', itemId)
        .maybeSingle()

      if (existing) {
        console.log('Replacing existing item for institution:', institutionId, '->', existing.item_id)
        try {
          await plaidClient.itemRemove({ access_token: existing.access_token })
        } catch (removeErr: any) {
          console.warn('Could not revoke old Plaid item (non-fatal):', removeErr?.message)
        }
        await supabase.from('plaid_items').delete().eq('item_id', existing.item_id)
      }
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

    if (upsertError) {
      console.error('Failed to store plaid item:', upsertError)
      throw new Error(`Failed to store item: ${upsertError.message}`)
    }

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

    return new Response(
      JSON.stringify({
        success: true,
        institution_name: institutionName,
        note: 'Account connected. Transactions will sync automatically within 24 hours, or tap Sync Now in Settings.',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error: any) {
    console.error('Exchange token error:', error?.response?.data ?? error?.message)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
