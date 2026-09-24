// find_plaid_orphans v1
// Pulls canonical transaction IDs from Plaid /transactions/get for each active
// plaid_item, compares against DB rows, and returns orphaned rows whose
// plaid_transaction_id doesn't exist in Plaid's response.
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

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing auth header')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Verify JWT and get user
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
    if (authErr || !user) throw new Error('Unauthorized')

    // Get all plaid items for this user
    const { data: items, error: itemsErr } = await supabase
      .from('plaid_items')
      .select('id, item_id, access_token, institution_name, status')
      .eq('user_id', user.id)
    if (itemsErr) throw itemsErr

    const activeItems = (items ?? []).filter(
      (i: { status?: string }) => !i.status || i.status === 'active',
    )
    if (activeItems.length === 0) {
      return new Response(JSON.stringify({
        orphans: [],
        scanned_accounts: 0,
        total_plaid_transactions: 0,
        warnings: [],
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Get all plaid accounts for these items
    const { data: accounts, error: accErr } = await supabase
      .from('plaid_accounts')
      .select('account_id, item_id')
      .in('item_id', activeItems.map((i: { item_id: string }) => i.item_id))
    if (accErr) throw accErr

    // Pull canonical transaction IDs from Plaid for each active item
    const canonicalIds = new Set<string>()
    const warnings: string[] = []
    const today = new Date().toISOString().split('T')[0]
    const twoYearsAgo = new Date(Date.now() - 730 * 86400000).toISOString().split('T')[0]

    for (const item of activeItems) {
      try {
        let offset = 0
        const PAGE_SIZE = 500

        const firstResp = await plaidClient.transactionsGet({
          access_token: item.access_token,
          start_date: twoYearsAgo,
          end_date: today,
          options: { count: PAGE_SIZE, offset: 0 },
        })

        const totalTx = firstResp.data.total_transactions
        for (const tx of firstResp.data.transactions) {
          canonicalIds.add(tx.transaction_id)
        }
        offset = firstResp.data.transactions.length

        while (offset < totalTx) {
          const resp = await plaidClient.transactionsGet({
            access_token: item.access_token,
            start_date: twoYearsAgo,
            end_date: today,
            options: { count: PAGE_SIZE, offset },
          })
          for (const tx of resp.data.transactions) {
            canonicalIds.add(tx.transaction_id)
          }
          offset += resp.data.transactions.length
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        warnings.push(
          `Failed to fetch from ${item.institution_name ?? item.item_id}: ${msg}`,
        )
      }
    }

    // Get all plaid-sourced DB transactions — paginate to avoid PostgREST 1000-row default cap
    const DB_PAGE = 1000
    let dbOffset = 0
    const allDbRows: Record<string, unknown>[] = []
    while (true) {
      const { data: page, error: dbErr } = await supabase
        .from('transactions')
        .select(
          'id, date, amount, merchant, account_display, plaid_transaction_id, schedule_c_category, notes, receipt_url, plaid_account_id',
        )
        .eq('user_id', user.id)
        .eq('source', 'plaid')
        .not('plaid_transaction_id', 'is', null)
        .range(dbOffset, dbOffset + DB_PAGE - 1)
      if (dbErr) throw dbErr
      if (!page || page.length === 0) break
      allDbRows.push(...page)
      if (page.length < DB_PAGE) break
      dbOffset += DB_PAGE
    }

    // Find orphans: DB rows whose plaid_transaction_id is not in Plaid's canonical set
    const orphans = allDbRows.filter(
      (row) => !canonicalIds.has(row.plaid_transaction_id as string),
    )

    return new Response(
      JSON.stringify({
        orphans,
        scanned_accounts: (accounts ?? []).length,
        total_plaid_transactions: canonicalIds.size,
        warnings,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: msg }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
