// plaid_sync_scheduled v17
// Daily cron sync for every user's Plaid items (pg_cron job → POST, service
// role, verify_jwt off: the cron call carries no user JWT).
//
// v17 (2026-11-09): runs the SAME per-item logic as the on-demand
// plaid_sync_transactions via ../_shared/plaidSync.ts. v16 and earlier were a
// stale fork ("matches plaid_sync_transactions v27") that:
//   - skipped user category_rules, so rules never applied to cron-synced rows
//   - didn't capture plaid_account_id / merchant_entity_id / v32 metadata
//     (so rules could never match those rows later either)
//   - had no settlement classification and no LOAN_PAYMENTS → transfer rule
//   - had no pending→posted handoff (pending rows were deleted + re-inserted,
//     losing user edits)
//   - never wrote plaid_items.status on Plaid errors
//   - imported npm:plaid@latest, which breaks on any redeploy (plaid@51)
// Both functions share plaid_items.cursor, so whichever runs first consumes
// the new transactions: they must behave identically.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { syncPlaidItem } from "../_shared/plaidSync.ts"

serve(async (_req) => {
  try {
    console.log('Starting scheduled sync...')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const { data: plaidItems, error: fetchError } = await supabase.from('plaid_items').select('*')
    if (fetchError) throw fetchError
    if (!plaidItems?.length) {
      return new Response(JSON.stringify({ success: true, message: 'No items to sync' }), { status: 200 })
    }

    console.log(`Found ${plaidItems.length} item(s)`)

    let totalAdded = 0, totalModified = 0, totalRemoved = 0, totalSettlements = 0, itemsProcessed = 0
    const warnings: string[] = []

    for (const item of plaidItems) {
      const r = await syncPlaidItem(supabase, item, item.user_id)
      totalAdded += r.added
      totalModified += r.modified
      totalRemoved += r.removed
      totalSettlements += r.settlements
      if (r.warning) warnings.push(`${item.item_id}: ${r.warning}`)
      itemsProcessed++
    }

    const summary = {
      success: true,
      items_processed: itemsProcessed,
      transactions_added: totalAdded,
      transactions_modified: totalModified,
      transactions_removed: totalRemoved,
      settlements_detected: totalSettlements,
      ...(warnings.length ? { warnings } : {}),
      synced_at: new Date().toISOString(),
    }
    console.log('Sync complete:', summary)
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error: any) {
    console.error('Scheduled sync failed:', error)
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 })
  }
})
