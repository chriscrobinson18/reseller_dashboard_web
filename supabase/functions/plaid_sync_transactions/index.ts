// plaid_sync_transactions v38
// v38: the per-item sync logic moved to ../_shared/plaidSync.ts so the daily
// cron (plaid_sync_scheduled) runs exactly the same code. This file is now
// only the authenticated HTTP wrapper (user JWT, optional item_id /
// reset_cursor). Behavior unchanged from v37.
// v37: classifySettlement only fires for credits on checking/savings-style
// depository accounts (Plaid account type + subtype passed in from the
// transactionsSync `accounts` list). Card credits (marketplace refunds) fall
// through to category rules / the PFC map instead of being tagged settlement.
// v36: LOAN_PAYMENTS → transfer in the PFC fallback; PayPal / Cash App wallet
// cash-outs classified as settlements (Venmo stays transfer — personal-only).
// Pinned npm:plaid@47.0.0 (was @latest): plaid@51 removed Configuration /
// PlaidApi / PlaidEnvironments, so any redeploy on @latest fails to load.
// v35: apply user category_rules to freshly-inserted rows before the PFC
// fallback. One SELECT per sync call fetches all rules that match the batch's
// entity IDs; a per-rule UPDATE stamps only null schedule_c_category rows.
// Rules run before PFC so user-defined mappings take precedence.
// v34: populate plaid_account_id on all new rows (tx.account_id, stable across
// item reconnects). Used by plaid_exchange_token v17's "Start fresh" deletion path
// and by the future duplicate review UI. No behavior change to sync logic.
// v32:
// Adds rich Plaid metadata capture: 14 new columns on transactions (logo, location,
// payment_channel, authorized_date, pending, detailed PFC + confidence, currency,
// plaid_metadata jsonb). A side-channel metadata UPDATE pass refreshes those fields
// on existing rows (so Force Full Resync backfills history without overwriting user
// edits: schedule_c_category, notes, related_sale_id, receipt_url, parent_settlement_id).
// Pending→posted handoff renames pending rows in place using pending_transaction_id,
// preserving any user edits on the pending row instead of delete-then-insert.
// CORS: handles OPTIONS preflight and returns Access-Control-Allow-Origin on every
// response so the web client (browser) can call this function. iOS native HTTPS
// callers ignore these headers — additive change, no behavioral impact for mobile.
// Settlement classification: sign-aware, precise merchant patterns.
// Positive credits (tx.amount < 0 in Plaid) from marketplace merchants = settlements.
// Negative debits (purchases on eBay/Amazon) are NOT settlements.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { syncPlaidItem } from "../_shared/plaidSync.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')

    const body = await req.json().catch(() => ({}))
    const filterItemId: string | null = body.item_id ?? null
    const resetCursor: boolean = body.reset_cursor === true

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

    let query = supabase.from('plaid_items').select('*').eq('user_id', user.id)
    if (filterItemId) query = query.eq('item_id', filterItemId)
    const { data: plaidItems } = await query

    if (!plaidItems?.length) {
      return new Response(
        JSON.stringify({ success: false, error: 'No Plaid accounts connected' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let totalAdded = 0
    let totalModified = 0
    let totalRemoved = 0
    let totalSettlements = 0
    const warnings: string[] = []

    for (const item of plaidItems) {
      const r = await syncPlaidItem(supabase, item, user.id, { resetCursor })
      totalAdded += r.added
      totalModified += r.modified
      totalRemoved += r.removed
      totalSettlements += r.settlements
      if (r.warning) warnings.push(r.warning)
    }

    return new Response(
      JSON.stringify({
        success: true,
        transactions_added: totalAdded,
        transactions_modified: totalModified,
        transactions_removed: totalRemoved,
        settlements_detected: totalSettlements,
        ...(warnings.length ? { warnings } : {}),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error: any) {
    console.error('Sync error:', error?.response?.data ?? error?.message ?? error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
