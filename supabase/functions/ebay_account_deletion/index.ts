// ebay_account_deletion v1
// Handles eBay Marketplace Account Deletion notifications (GDPR compliance).
//
// Two request types:
//   GET ?challenge_code=<code>  → responds with SHA256 challenge response (endpoint verification)
//   POST <notification body>    → deletes user's ebay_tokens + ebay_api transactions

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const VERIFICATION_TOKEN = Deno.env.get('EBAY_DELETION_VERIFICATION_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// The full public URL of this function — used in the challenge hash
const ENDPOINT_URL = `${SUPABASE_URL}/functions/v1/ebay_account_deletion`

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  const url = new URL(req.url)

  // GET: challenge verification handshake
  if (req.method === 'GET') {
    const challengeCode = url.searchParams.get('challenge_code')
    if (!challengeCode) return json(400, { error: 'Missing challenge_code' })

    // eBay requires: sha256(challengeCode + verificationToken + endpointUrl)
    const data = new TextEncoder().encode(challengeCode + VERIFICATION_TOKEN + ENDPOINT_URL)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    return json(200, { challengeResponse: hashHex })
  }

  // POST: account deletion notification
  if (req.method === 'POST') {
    let body: any
    try {
      body = await req.json()
    } catch {
      return json(400, { error: 'Invalid JSON body' })
    }

    const ebayUserId: string | undefined = body?.notification?.data?.userId
    if (!ebayUserId) {
      console.error('Missing userId in deletion notification:', JSON.stringify(body))
      // Return 200 so eBay doesn't retry — malformed notifications are non-actionable
      return json(200, { received: true })
    }

    console.log('Account deletion notification for eBay userId:', ebayUserId)

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Find our user by eBay userId
    const { data: tokenRow, error: lookupErr } = await supabase
      .from('ebay_tokens')
      .select('user_id')
      .eq('ebay_user_id', ebayUserId)
      .maybeSingle()

    if (lookupErr) {
      console.error('Token lookup error:', lookupErr.message)
      return json(500, { error: 'Lookup failed' })
    }

    if (!tokenRow) {
      console.log('No matching user for eBay userId:', ebayUserId, '— nothing to delete')
      return json(200, { received: true })
    }

    const userId = tokenRow.user_id
    console.log('Deleting eBay data for user:', userId)

    // Delete all ebay_api transactions
    const { error: txErr } = await supabase
      .from('transactions')
      .delete()
      .eq('user_id', userId)
      .eq('source', 'ebay_api')

    if (txErr) console.error('Transaction delete error (non-fatal):', txErr.message)

    // Delete the token row
    const { error: tokenErr } = await supabase
      .from('ebay_tokens')
      .delete()
      .eq('user_id', userId)

    if (tokenErr) {
      console.error('Token delete error:', tokenErr.message)
      return json(500, { error: 'Token delete failed' })
    }

    console.log('eBay account deletion complete for user:', userId)
    return json(200, { received: true })
  }

  return json(405, { error: 'Method not allowed' })
})
