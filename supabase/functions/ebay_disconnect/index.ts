// Revokes eBay OAuth tokens on eBay's side, then deletes the local ebay_tokens row.
// This ensures the next "Connect" shows a fresh eBay consent screen.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
const isSandbox = Deno.env.get('EBAY_ENV') === 'sandbox'
const EBAY_REVOKE_URL = isSandbox
  ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token/revoke'
  : 'https://api.ebay.com/identity/v1/oauth2/token/revoke'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Authenticate the calling user via their JWT
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json(401, { error: 'Missing Authorization header' })
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authErr || !user) return json(401, { error: 'Unauthorized' })

    // Look up their token row
    const { data: tokenRow } = await supabase
      .from('ebay_tokens')
      .select('refresh_token')
      .eq('user_id', user.id)
      .maybeSingle()

    // Revoke on eBay's side (best-effort — don't fail disconnect if this fails)
    if (tokenRow?.refresh_token) {
      const creds = btoa(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`)
      try {
        await fetch(EBAY_REVOKE_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${creds}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: tokenRow.refresh_token,
            token_type_hint: 'refresh_token',
          }).toString(),
        })
      } catch (revokeErr) {
        console.error('eBay token revocation failed (continuing with local delete):', revokeErr)
      }
    }

    // Delete local token row
    const { error: deleteErr } = await supabase
      .from('ebay_tokens')
      .delete()
      .eq('user_id', user.id)

    if (deleteErr) throw deleteErr

    return json(200, { success: true })
  } catch (err: any) {
    console.error('ebay_disconnect error:', err)
    return json(500, { error: err.message ?? String(err) })
  }
})
