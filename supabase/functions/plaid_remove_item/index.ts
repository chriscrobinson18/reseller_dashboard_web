// plaid_remove_item v2
// CORS: handles OPTIONS preflight and returns Access-Control-Allow-Origin on every
// response so the web client (browser) can call this function. iOS native HTTPS
// callers ignore these headers — additive change, no behavioral impact for mobile.
// Disconnects a Plaid item for the authenticated user.
// Calls Plaid /item/remove, then deletes the row from plaid_items.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { Configuration, PlaidApi, PlaidEnvironments } from "npm:plaid@latest"

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

    const { item_id } = await req.json()
    if (!item_id) {
      return new Response(
        JSON.stringify({ error: 'item_id required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: plaidItem, error: fetchError } = await supabase
      .from('plaid_items')
      .select('*')
      .eq('user_id', user.id)
      .eq('item_id', item_id)
      .single()

    if (fetchError || !plaidItem) {
      return new Response(
        JSON.stringify({ error: 'Item not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    try {
      await plaidClient.itemRemove({ access_token: plaidItem.access_token })
      console.log('Plaid item removed:', item_id)
    } catch (plaidErr: any) {
      console.warn('Plaid itemRemove failed (non-fatal):', plaidErr?.message)
    }

    await supabase
      .from('plaid_items')
      .delete()
      .eq('user_id', user.id)
      .eq('item_id', item_id)

    console.log('Item deleted from DB:', item_id)

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error: any) {
    console.error('Remove item error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
