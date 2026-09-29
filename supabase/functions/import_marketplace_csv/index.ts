// import_marketplace_csv v20
// Add: Amazon Date Range Transaction Report parser (amz_dr_* keys). Auto-detected
//      from header: has 'settlement id' + 'transaction status'. Enables Settlement
//      Status for Amazon and captures per-order shipping label costs. Deferred rows
//      (Transaction Status=Deferred) are skipped — not yet released to payout.
// Prior: import_marketplace_csv v19
// Add: eBay Order Earnings Report parser. Writes directly to `sales` table
//      (not `transactions`) with per-order fee breakdown, shipping label cost,
//      discount, and refund data. Groups multi-item orders into one sale row.
//      Uses existing unique index (user_id, external_order_id) for idempotent
//      upsert on overlapping date ranges.
// Prior: import_marketplace_csv v18
// Fix: Amazon Transaction View no longer DELETEs all existing rows before
//      importing. Now uses the same upsert+ignoreDuplicates approach as eBay
//      and Mercari, so re-importing preserves related_sale_id links set by
//      Return Reconciliation, parent_settlement_id set by Settlement matching,
//      and any manual category changes. Amazon TV rows don't get revised once
//      settled — refunds/adjustments appear as new rows, not edits.
// Fix: eBay Refund rows now get a unique csv_transaction_id. Previously,
//      Transaction ID is always '--' for Refund rows, which is truthy in JS,
//      so `transId || refId` returned '--' for every refund — meaning only the
//      first eBay refund ever upserted (all others silently skipped by
//      ignoreDuplicates). Now uses sanitized Reference ID (e.g. "Return ID
//      5305955544") or falls back to orderNumber+date.
// Fix: Amazon Transaction View shipping rows now distinguish return-postage
//      labels (productName contains 'return') from outbound labels. Return
//      labels get merchant='Amazon Return Label'; outbound get
//      'Amazon Shipping Label'; adjustments keep 'Amazon Shipping Adjustment'.
//      This lets csvReturns.ts match on merchant without relying on dates.
// Prior: import_marketplace_csv v16
// Fix: Amazon Settlement Report Order rows now use `description` as merchant
//      (product name) instead of orderId, matching actual Amazon CSV column.
// Fix: response now includes `amazon_format` field for diagnostics.
// Fix: TV detection broadened — also detects if header has 'description' + 'type' + 'order id'
//      but NOT 'product sales' (distinguishes TV from SR which has both).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

function parseCSV(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const len = text.length
  for (let i = 0; i < len; i++) {
    const ch = text[i]
    const next = i + 1 < len ? text[i + 1] : ''
    if (ch === '"') {
      if (inQuotes && next === '"') { field += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      row.push(field.trim()); field = ''
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++
      row.push(field.trim()); field = ''
      if (row.some(f => f !== '' && f !== '--')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field || row.length > 0) { row.push(field.trim()); if (row.some(f => f !== '' && f !== '--')) rows.push(row) }
  return rows
}

function parseAmount(s: string): number {
  if (!s || s === '--' || s === '') return 0
  const neg = s.trim().startsWith('(') && s.trim().endsWith(')')
  const clean = neg ? s.trim().slice(1, -1) : s
  const f = parseFloat(clean.replace(/[,$"]/g, '')) || 0
  return neg ? -f : f
}

const MONTH_MAP: Record<string,string> = {
  jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'
}
function parseDateAny(s: string): string | null {
  if (!s || s === '--') return null
  const clean = s.replace(/"/g, '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(clean)) return clean.slice(0, 10)
  const slash = clean.split('/')
  if (slash.length === 3 && slash[2].length === 4)
    return `${slash[2]}-${slash[0].padStart(2,'0')}-${slash[1].padStart(2,'0')}`
  const m1 = clean.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (m1) { const mo = MONTH_MAP[m1[1].toLowerCase().slice(0,3)]; if (mo) return `${m1[3]}-${mo}-${m1[2].padStart(2,'0')}` }
  const m2 = clean.match(/^(\w{3})[-\s]+(\d{1,2})[-,\s]+(\d{4})/)
  if (m2) { const mo = MONTH_MAP[m2[1].toLowerCase()]; if (mo) return `${m2[3]}-${mo}-${m2[2].padStart(2,'0')}` }
  return null
}

/** Returns s if it's a non-empty, non-dash value; otherwise null. */
function notDash(s: string): string | null {
  return (s && s !== '--') ? s : null
}

const BATCH = 200

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return json(401, { error: 'Unauthorized' })

    const body = await req.json()
    const platform: string = body.platform
    const csvText: string = body.csv_text
    if (!csvText || !platform) return json(400, { error: 'Missing platform or csv_text' })

    const allRows = parseCSV(csvText)
    const transactions: any[] = []
    let rowsParsed = 0
    let rowsSkipped = 0
    const skippedTypes: Record<string, number> = {}
    const trackSkip = (reason: string) => { rowsSkipped++; skippedTypes[reason] = (skippedTypes[reason] ?? 0) + 1 }
    let amazonFormat = ''

    // ──────────────────────────────
    // AMAZON
    // ──────────────────────────────
    if (platform === 'amazon') {
      let headerIdx = -1
      let isTransactionView = false
      let isDateRange = false

      for (let i = 0; i < allRows.length; i++) {
        const norm = allRows[i].map(h => h.replace(/"/g,'').trim().toLowerCase())
        const hasSettlementId  = norm.includes('settlement id')
        const hasProductDetails = norm.includes('product details')
        const hasTxType        = norm.includes('transaction type')
        const hasOrderId       = norm.includes('order id')
        const hasTotalCharges  = norm.includes('total product charges')
        const hasProductSales  = norm.includes('product sales')  // SR-specific column
        const hasTotalUSD      = norm.includes('total (usd)') || norm.includes('total')

        // True Transaction View (Python-style): has 'product details' or 'total product charges'
        if (hasProductDetails || hasTotalCharges) {
          headerIdx = i; isTransactionView = true; break
        }
        // New Date Range Transaction Report: has settlement id + transaction status
        const hasTransactionStatus = norm.includes('transaction status')
        if (hasSettlementId && hasTransactionStatus) {
          headerIdx = i; isDateRange = true; break
        }
        // Standard SR / Transaction View hybrid: settlement id present
        // If it also has 'type'+'order id' but NOT 'product sales', treat as TV
        // (Amazon sometimes exports Transaction View with settlement id but TV columns)
        if (hasSettlementId) {
          if (hasTxType && hasOrderId && !hasProductSales) {
            headerIdx = i; isTransactionView = true
          } else {
            headerIdx = i; isTransactionView = false
          }
          break
        }
        // TV without settlement id
        if (hasTxType && hasOrderId) {
          headerIdx = i; isTransactionView = true; break
        }
      }

      if (headerIdx === -1) {
        return json(400, { error: 'Could not detect Amazon report format. Use: Seller Central → Reports → Payments → Transaction View.' })
      }

      const header = allRows[headerIdx].map(h => h.replace(/"/g,'').trim().toLowerCase())
      amazonFormat = isDateRange ? 'date_range' : isTransactionView ? 'transaction_view' : 'settlement_report'
      console.log(`Amazon format: ${amazonFormat}, header cols: ${header.slice(0,10).join(', ')}`)

      const col = (row: string[], name: string) => row[header.indexOf(name)]?.replace(/"/g,'').trim() ?? ''
      const colAny = (row: string[], ...names: string[]) => {
        for (const name of names) { const idx = header.indexOf(name); if (idx !== -1) return row[idx]?.replace(/"/g,'').trim() ?? '' }
        return ''
      }

      // ── Amazon Date Range Transaction Report ──────────────────────────────
      if (isDateRange) {
        for (let i = headerIdx + 1; i < allRows.length; i++) {
          const r = allRows[i]
          const dateRaw     = col(r, 'date/time')
          const settlementId = col(r, 'settlement id')
          const type         = col(r, 'type')
          const orderId      = col(r, 'order id')
          const description  = col(r, 'description')
          const txStatus     = col(r, 'transaction status')

          if (txStatus === 'Deferred') { trackSkip('deferred'); continue }

          const date = parseDateAny(dateRaw)
          if (!date) { trackSkip('bad_date'); continue }
          if (!settlementId) { trackSkip('no_settlement_id'); continue }

          const safeOrder = orderId.replace(/[^a-zA-Z0-9_-]/g, '_')
          const groupId   = settlementId

          const productSales = parseAmount(col(r, 'product sales'))
          const sellingFees  = parseAmount(col(r, 'selling fees'))
          const fbaFees      = parseAmount(col(r, 'fba fees'))
          const total        = parseAmount(col(r, 'total'))

          if (type === 'Order') {
            if (productSales !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: productSales, gross_amount: productSales,
                merchant: description || orderId || 'Amazon Sale',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'payout', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_${safeOrder}_sales`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            }
            if (sellingFees !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: sellingFees, gross_amount: null,
                merchant: 'Amazon Fees',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'commissions_fees', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_${safeOrder}_fees`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            }
            if (fbaFees !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: fbaFees, gross_amount: null,
                merchant: 'Amazon FBA Fees',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'commissions_fees', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_${safeOrder}_fba`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            }
            if (productSales === 0 && sellingFees === 0 && fbaFees === 0) trackSkip('order_all_zero')

          } else if (type === 'Shipping Services') {
            if (total !== 0) {
              const descLower = description.toLowerCase()
              const isReturn  = descLower.includes('returnpostage') || descLower.includes('return postage')
              const isAdj     = descLower.includes('adjustment')
              const merchant  = isReturn ? 'Amazon Return Label' : isAdj ? 'Amazon Shipping Adjustment' : 'Amazon Shipping Label'
              const suffix    = isReturn ? 'return_ship' : isAdj ? 'ship_adj' : 'ship'
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: total, gross_amount: null,
                merchant,
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'shipping_postage', record_type: 'transaction',
                csv_transaction_id: orderId
                  ? `amz_dr_${settlementId}_${safeOrder}_${suffix}`
                  : `amz_dr_${settlementId}_${suffix}_${Math.round(Math.abs(total) * 100)}`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            } else { trackSkip('shipping_zero') }

          } else if (type === 'Refund') {
            if (total !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: total, gross_amount: null,
                merchant: description || (orderId ? `Amazon Refund ${orderId}` : 'Amazon Refund'),
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'payout', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_${safeOrder}_refund`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            } else { trackSkip('refund_zero') }

          } else if (type === 'Transfer') {
            if (total !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: total, gross_amount: null,
                merchant: 'Amazon Transfer',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'transfer', record_type: 'transaction',
                // One Transfer per settlement assumed (matches SR parser behavior).
                // If Amazon ever emits two Transfer rows for one settlement, the second
                // is silently skipped by ignoreDuplicates — first-write wins.
                csv_transaction_id: `amz_dr_${settlementId}_transfer`,
                csv_group_id: groupId, notes: null, parent_settlement_id: null })
            } else { trackSkip('transfer_zero') }

          } else if (type === 'Debt') {
            if (total !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: total, gross_amount: null,
                merchant: 'Amazon Debt Carry',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'balance_adjustment', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_debt`,
                csv_group_id: groupId, notes: null, parent_settlement_id: null })
            } else { trackSkip('debt_zero') }

          } else if (type === 'Service Fee') {
            trackSkip('intentional:ServiceFee')
          } else {
            trackSkip(`amz_dr_type:${type || 'empty'}`)
          }
        }

      // ── Amazon Transaction View (Python-style CSV) ────────────────────────
      } else if (isTransactionView) {
        for (let i = headerIdx + 1; i < allRows.length; i++) {
          const r = allRows[i]
          const dateRaw     = colAny(r, 'date/time', 'date', 'transaction date')
          const type        = colAny(r, 'transaction type', 'type')
          const orderId     = colAny(r, 'order id', 'order #', 'orderid')
          const productName = colAny(r, 'product details', 'total product charges', 'product name', 'title', 'description', 'sku')
          const productSales = parseAmount(colAny(r, 'total product charges', 'product sales', 'item price'))
          const amazonFees  = parseAmount(colAny(r, 'amazon fees', 'selling fees', 'fees'))
          const promoRebates = parseAmount(colAny(r, 'total promotional rebates', 'promotional rebates'))
          const rowTotal    = parseAmount(colAny(r, 'total (usd)', 'total', 'net amount'))
          const date        = parseDateAny(dateRaw)

          if (!date) { trackSkip('bad_date'); continue }

          const groupId   = `amz_tv_${date.slice(0, 7)}`
          const safeOrder = (orderId || '').replace(/[^a-zA-Z0-9_-]/g, '_')
          const safeType  = (type || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
          const typeLower = type.toLowerCase()

          if (typeLower === 'order payment' || typeLower === 'order') {
            if (productSales !== 0) {
              rowsParsed++
              transactions.push({
                user_id: user.id, date, amount: productSales, gross_amount: productSales,
                merchant: productName || orderId || 'Amazon Sale',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'payout', record_type: 'transaction',
                csv_transaction_id: `amz_tv_${safeOrder}_sales`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null,
              })
            }
            if (amazonFees !== 0) {
              rowsParsed++
              transactions.push({
                user_id: user.id, date, amount: amazonFees, gross_amount: null,
                merchant: 'Amazon Fees', type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'commissions_fees', record_type: 'transaction',
                csv_transaction_id: `amz_tv_${safeOrder}_fees`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null,
              })
            }
            if (promoRebates !== 0) {
              rowsParsed++
              transactions.push({
                user_id: user.id, date, amount: promoRebates, gross_amount: null,
                merchant: 'Amazon Promo Rebate', type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'payout', record_type: 'transaction',
                csv_transaction_id: `amz_tv_${safeOrder}_promo`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null,
              })
            }
            if (productSales === 0 && amazonFees === 0 && promoRebates === 0) trackSkip('order_all_zero')
          } else if (typeLower === 'refund') {
            if (rowTotal !== 0) {
              rowsParsed++
              transactions.push({
                user_id: user.id, date, amount: rowTotal, gross_amount: null,
                merchant: productName || (orderId ? `Amazon Refund ${orderId}` : 'Amazon Refund'),
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'payout', record_type: 'transaction',
                csv_transaction_id: `amz_tv_${safeOrder}_refund`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null,
              })
            } else { trackSkip('refund_zero') }
          } else if (typeLower.includes('shipping service')) {
            if (rowTotal !== 0) {
              const productLower = (productName || '').toLowerCase()
              const isReturnLabel = productLower.includes('return')
              const isAdj = productLower.includes('adjustment')
              const merchant = isReturnLabel
                ? 'Amazon Return Label'
                : isAdj
                  ? 'Amazon Shipping Adjustment'
                  : 'Amazon Shipping Label'
              rowsParsed++
              transactions.push({
                user_id: user.id, date, amount: rowTotal, gross_amount: null,
                merchant,
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'shipping_postage', record_type: 'transaction',
                csv_transaction_id: `amz_tv_${date}_${safeType}_${Math.round(Math.abs(rowTotal) * 100)}_${isReturnLabel ? 'ship_return' : isAdj ? 'ship_adj' : 'ship'}`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null,
              })
            } else { trackSkip('shipping_zero') }
          } else if (typeLower === 'transfer' || typeLower === 'disbursement') {
            if (rowTotal !== 0) {
              rowsParsed++
              transactions.push({
                user_id: user.id, date, amount: rowTotal, gross_amount: null,
                merchant: 'Amazon Transfer', type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'transfer', record_type: 'transaction',
                csv_transaction_id: `amz_tv_${date}_transfer_${Math.round(Math.abs(rowTotal) * 100)}`,
                csv_group_id: groupId, notes: null, parent_settlement_id: null,
              })
            } else { trackSkip('transfer_zero') }
          } else {
            if (rowTotal !== 0) {
              rowsParsed++
              transactions.push({
                user_id: user.id, date, amount: rowTotal, gross_amount: null,
                merchant: productName || `Amazon ${type}`, type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'other_expense', record_type: 'transaction',
                csv_transaction_id: `amz_tv_${date}_${safeType}_${Math.round(Math.abs(rowTotal) * 100)}_other`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null,
              })
            } else { trackSkip(`amazon_tv_type:${type || 'empty'}`) }
          }
        }

      // ── Amazon Settlement Report ─────────────────────────────────────────
      } else {
        for (let i = headerIdx + 1; i < allRows.length; i++) {
          const r = allRows[i]
          const dateRaw      = col(r, 'date/time')
          const settlementId = col(r, 'settlement id')
          const type         = col(r, 'type')
          const orderId      = col(r, 'order id')
          const description  = col(r, 'description')
          const date         = parseDateAny(dateRaw)
          const rowTotal     = parseAmount(col(r, 'total'))

          if (!date) { trackSkip('bad_date'); continue }
          if (!settlementId) { trackSkip('no_settlement_id'); continue }

          const idBase = `amz_sr_${settlementId}_${orderId || description || type}`

          if (type === 'Previous statement balance' || type === 'Beginning balance') {
            if (rowTotal !== 0) {
              rowsParsed++
              transactions.push({
                user_id: user.id, date, amount: rowTotal, gross_amount: null, merchant: type,
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'balance_adjustment', record_type: 'transaction',
                csv_transaction_id: `amz_sr_${settlementId}_${type === 'Previous statement balance' ? 'prev_bal' : 'begin_bal'}`,
                csv_group_id: settlementId, notes: null, parent_settlement_id: null,
              })
            } else { trackSkip(`${type}_zero`) }
            continue
          }
          if (type === 'Transfer') {
            if (rowTotal !== 0) {
              rowsParsed++
              transactions.push({
                user_id: user.id, date, amount: rowTotal, gross_amount: null, merchant: 'Amazon Transfer',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'transfer', record_type: 'transaction',
                csv_transaction_id: `amz_sr_${settlementId}_transfer`,
                csv_group_id: settlementId, notes: null, parent_settlement_id: null,
              })
            } else { trackSkip('transfer_zero') }
            continue
          }

          const productSales    = parseAmount(col(r, 'product sales'))
          const shippingCredits = parseAmount(col(r, 'shipping credits'))
          const promoRebates    = parseAmount(col(r, 'promotional rebates'))
          const sellingFees     = parseAmount(col(r, 'selling fees'))
          const fbaFees         = parseAmount(col(r, 'fba fees'))
          const otherTxFees     = parseAmount(col(r, 'other transaction fees'))

          if (type === 'Order') {
            if (productSales !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: productSales, gross_amount: productSales, merchant: description || orderId || 'Amazon Sale', type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'payout', record_type: 'transaction', csv_transaction_id: `${idBase}_sales`, csv_group_id: settlementId, notes: orderId || null, parent_settlement_id: null }) }
            if (shippingCredits !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: shippingCredits, gross_amount: null, merchant: 'Amazon Shipping Credit', type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'payout', record_type: 'transaction', csv_transaction_id: `${idBase}_ship_credit`, csv_group_id: settlementId, notes: orderId || null, parent_settlement_id: null }) }
            if (promoRebates !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: promoRebates, gross_amount: null, merchant: 'Amazon Promo Rebate', type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'payout', record_type: 'transaction', csv_transaction_id: `${idBase}_promo`, csv_group_id: settlementId, notes: orderId || null, parent_settlement_id: null }) }
            if (sellingFees !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: sellingFees, gross_amount: null, merchant: 'Amazon Selling Fees', type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'commissions_fees', record_type: 'transaction', csv_transaction_id: `${idBase}_selling_fees`, csv_group_id: settlementId, notes: orderId || null, parent_settlement_id: null }) }
            if (fbaFees !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: fbaFees, gross_amount: null, merchant: 'Amazon FBA Fees', type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'commissions_fees', record_type: 'transaction', csv_transaction_id: `${idBase}_fba_fees`, csv_group_id: settlementId, notes: orderId || null, parent_settlement_id: null }) }
            if (otherTxFees !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: otherTxFees, gross_amount: null, merchant: 'Amazon Other Fees', type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'commissions_fees', record_type: 'transaction', csv_transaction_id: `${idBase}_other_fees`, csv_group_id: settlementId, notes: orderId || null, parent_settlement_id: null }) }
            if (productSales === 0 && shippingCredits === 0 && promoRebates === 0 && sellingFees === 0 && fbaFees === 0 && otherTxFees === 0) trackSkip('order_all_zero')
          } else if (type === 'Refund') {
            if (rowTotal !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: rowTotal, gross_amount: null, merchant: description || (orderId ? `Amazon Refund ${orderId}` : 'Amazon Refund'), type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'payout', record_type: 'transaction', csv_transaction_id: `${idBase}_refund`, csv_group_id: settlementId, notes: orderId || null, parent_settlement_id: null }) } else { trackSkip('refund_zero') }
          } else if (type === 'Shipping Services') {
            if (rowTotal !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: rowTotal, gross_amount: null, merchant: description || 'Amazon Shipping', type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'shipping_postage', record_type: 'transaction', csv_transaction_id: `${idBase}_${Math.abs(rowTotal)}_ship`, csv_group_id: settlementId, notes: orderId || null, parent_settlement_id: null }) } else { trackSkip('shipping_zero') }
          } else if (type === 'Adjustment' || type === 'FBA Inventory Credit' || type === 'Loan') {
            if (rowTotal !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: rowTotal, gross_amount: null, merchant: description || `Amazon ${type}`, type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'other_expense', record_type: 'transaction', csv_transaction_id: `${idBase}_${Math.abs(rowTotal)}_adj`, csv_group_id: settlementId, notes: null, parent_settlement_id: null }) } else { trackSkip(`${type}_zero`) }
          } else {
            if (rowTotal !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: rowTotal, gross_amount: null, merchant: description || `Amazon ${type}`, type: 'other', source: 'csv_import', platform: 'amazon', schedule_c_category: 'other_expense', record_type: 'transaction', csv_transaction_id: `${idBase}_${Math.abs(rowTotal)}_other`, csv_group_id: settlementId, notes: null, parent_settlement_id: null }) } else { trackSkip(`amazon_sr_type:${type || 'empty'}`) }
          }
        }
      }

    // ──────────────────────────────
    // EBAY — Seller Hub Transaction Report
    // ──────────────────────────────
    } else if (platform === 'ebay') {
      let headerIdx = -1
      for (let i = 0; i < allRows.length; i++) {
        if (allRows[i][0]?.replace(/"/g,'').trim() === 'Transaction creation date') { headerIdx = i; break }
      }
      if (headerIdx === -1) return json(400, { error: 'Could not find eBay CSV header row (expected first column: "Transaction creation date")' })

      const header = allRows[headerIdx].map(h => h.replace(/"/g,'').trim())
      const col = (row: string[], name: string) => row[header.indexOf(name)]?.replace(/"/g,'').trim() ?? ''

      for (let i = headerIdx + 1; i < allRows.length; i++) {
        const r           = allRows[i]
        const type        = col(r, 'Type')
        const date        = parseDateAny(col(r, 'Transaction creation date'))
        const payoutId    = col(r, 'Payout ID')
        const transId     = col(r, 'Transaction ID')
        const refId       = col(r, 'Reference ID')
        const itemTitle   = col(r, 'Item title')
        const netAmount   = parseAmount(col(r, 'Net amount'))
        const grossAmount = parseAmount(col(r, 'Gross transaction amount'))
        const fvfFixed    = parseAmount(col(r, 'Final Value Fee - fixed'))
        const fvfVariable = parseAmount(col(r, 'Final Value Fee - variable'))
        const description = col(r, 'Description')
        const orderNumber = col(r, 'Order number')

        if (!date) { trackSkip('bad_date'); continue }

        const hasPayoutId = payoutId && payoutId !== '--' && payoutId !== ''
        const groupId = hasPayoutId ? payoutId : null

        if (type === 'Payout') {
          if (netAmount !== 0 && groupId) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: netAmount, gross_amount: null, merchant: 'eBay Payout', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'transfer', record_type: 'transaction', csv_transaction_id: `ebay_payout_${payoutId}`, csv_group_id: groupId, notes: null, parent_settlement_id: null }) } else { trackSkip('intentional:Payout') }
          continue
        }
        if (type === 'Reserve' || type === 'Hold') {
          if (netAmount !== 0 && groupId) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: netAmount, gross_amount: null, merchant: description.slice(0,100) || `eBay ${type}`, type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'balance_adjustment', record_type: 'transaction', csv_transaction_id: `ebay_${notDash(refId) || (date + '_' + type.toLowerCase() + '_' + Math.abs(netAmount))}_bal`, csv_group_id: groupId, notes: null, parent_settlement_id: null }) } else { trackSkip(`intentional:${type}`) }
          continue
        }
        if (type === 'Transfer' || type === 'Secondary payout') { trackSkip(`intentional:${type}`); continue }

        if (type === 'Order') {
          rowsParsed++
          transactions.push({ user_id: user.id, date, amount: grossAmount || netAmount, gross_amount: grossAmount || null, merchant: itemTitle || 'eBay Sale', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'payout', record_type: 'transaction', csv_transaction_id: `ebay_${notDash(transId) || orderNumber}_order`, csv_group_id: groupId, notes: notDash(orderNumber), parent_settlement_id: null })
          const fvfTotal = fvfFixed + fvfVariable
          if (fvfTotal !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: fvfTotal, gross_amount: null, merchant: 'eBay Final Value Fee', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'commissions_fees', record_type: 'transaction', csv_transaction_id: `ebay_${notDash(transId) || orderNumber}_fvf`, csv_group_id: groupId, notes: notDash(orderNumber), parent_settlement_id: null }) }
        } else if (type === 'Other fee') {
          const isPromoted = description.toLowerCase().includes('promoted')
          rowsParsed++
          transactions.push({ user_id: user.id, date, amount: netAmount, gross_amount: null, merchant: description.slice(0,100) || 'eBay Fee', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: isPromoted ? 'advertising' : 'commissions_fees', record_type: 'transaction', csv_transaction_id: `ebay_${notDash(refId) || notDash(transId) || (notDash(orderNumber) + '_fee')}_fee`, csv_group_id: groupId, notes: notDash(orderNumber), parent_settlement_id: null })
        } else if (type === 'Shipping label') {
          rowsParsed++
          transactions.push({ user_id: user.id, date, amount: netAmount, gross_amount: null, merchant: 'eBay Shipping Label', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'shipping_postage', record_type: 'transaction', csv_transaction_id: `ebay_${notDash(refId) || notDash(transId) || (date + '_ship_' + Math.abs(netAmount))}_ship`, csv_group_id: groupId, notes: notDash(orderNumber), parent_settlement_id: null })
        } else if (type === 'Refund') {
          // Use sanitized Reference ID (e.g. "Return_ID_5305955544") as the stable unique key.
          // Transaction ID is always '--' for eBay Refund rows — using it directly caused every
          // refund after the first to be silently dropped (ignoreDuplicates on 'ebay_--_refund').
          const safeRefId = (notDash(refId) ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')
          const refundIdKey = safeRefId || (notDash(orderNumber) + '_' + date + '_refund')
          rowsParsed++
          transactions.push({ user_id: user.id, date, amount: netAmount, gross_amount: null, merchant: itemTitle || 'eBay Refund', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'payout', record_type: 'transaction', csv_transaction_id: `ebay_${refundIdKey}_refund`, csv_group_id: groupId, notes: notDash(orderNumber), parent_settlement_id: null })
        } else if (type === 'Charge') {
          rowsParsed++
          transactions.push({ user_id: user.id, date, amount: netAmount, gross_amount: null, merchant: description.slice(0,100) || 'eBay Charge', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'other_expense', record_type: 'transaction', csv_transaction_id: `ebay_${notDash(refId) || (date + '_charge')}_charge`, csv_group_id: groupId, notes: null, parent_settlement_id: null })
        } else if (type === 'Claim') {
          rowsParsed++
          transactions.push({ user_id: user.id, date, amount: netAmount, gross_amount: null, merchant: itemTitle || 'eBay Claim', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'other_expense', record_type: 'transaction', csv_transaction_id: `ebay_${notDash(refId) || notDash(orderNumber)}_claim`, csv_group_id: groupId, notes: notDash(orderNumber), parent_settlement_id: null })
        } else if (type === 'Adjustment') {
          rowsParsed++
          transactions.push({ user_id: user.id, date, amount: netAmount, gross_amount: null, merchant: description.slice(0,100) || 'eBay Adjustment', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'other_expense', record_type: 'transaction', csv_transaction_id: `ebay_${notDash(refId)}_adj`, csv_group_id: groupId, notes: null, parent_settlement_id: null })
        } else if (type === 'Withheld tax') {
          rowsParsed++
          transactions.push({ user_id: user.id, date, amount: netAmount, gross_amount: null, merchant: 'eBay Withheld Tax', type: 'other', source: 'csv_import', platform: 'ebay', schedule_c_category: 'taxes_licenses', record_type: 'transaction', csv_transaction_id: `ebay_${notDash(refId)}_tax`, csv_group_id: groupId, notes: null, parent_settlement_id: null })
        } else {
          trackSkip(`ebay_type:${type || 'empty'}`)
        }
      }

    // ──────────────────────────────
    // MERCARI
    // ──────────────────────────────
    } else if (platform === 'mercari') {
      let headerIdx = -1
      for (let i = 0; i < allRows.length; i++) {
        const norm = allRows[i].map(h => h.replace(/"/g,'').trim().toLowerCase())
        if (norm.includes('item id') && norm.includes('sold date')) { headerIdx = i; break }
      }
      if (headerIdx === -1) return json(400, { error: 'Could not find Mercari CSV header. Expected columns: Item Id, Sold Date, Item Title, Item Price, etc.' })

      const header = allRows[headerIdx].map(h => h.replace(/"/g,'').trim().toLowerCase())
      const col = (row: string[], name: string) => row[header.indexOf(name)]?.replace(/"/g,'').trim() ?? ''

      for (let i = headerIdx + 1; i < allRows.length; i++) {
        const r = allRows[i]
        const itemId   = col(r, 'item id')
        const soldDate = col(r, 'sold date')
        const title    = col(r, 'item title')

        if (!itemId || /total|report/i.test(itemId)) { trackSkip('summary_row'); continue }

        const date = parseDateAny(soldDate)
        if (!date) { trackSkip('bad_date'); continue }

        const itemPrice         = parseAmount(col(r, 'item price'))
        const buyerShipping     = parseAmount(col(r, 'buyer shipping fee'))
        const sellerShipping    = parseAmount(col(r, 'seller shipping fee'))
        const mercariSellingFee = parseAmount(col(r, 'mercari selling fee'))
        const processingFee     = parseAmount(col(r, 'payment processing fee charged to seller'))
        const shippingAdjFee    = parseAmount(col(r, 'shipping adjustment fee'))

        const groupId = `mercari_${date.slice(0, 7)}`
        const safeId  = itemId.replace(/[^a-zA-Z0-9_-]/g, '_')

        if (itemPrice !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: itemPrice, gross_amount: itemPrice, merchant: title || 'Mercari Sale', type: 'other', source: 'csv_import', platform: 'mercari', schedule_c_category: 'payout', record_type: 'transaction', csv_transaction_id: `mercari_${safeId}_sales`, csv_group_id: groupId, notes: itemId, parent_settlement_id: null }) }
        if (buyerShipping !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: buyerShipping, gross_amount: null, merchant: 'Mercari Buyer Shipping', type: 'other', source: 'csv_import', platform: 'mercari', schedule_c_category: 'payout', record_type: 'transaction', csv_transaction_id: `mercari_${safeId}_buyer_ship`, csv_group_id: groupId, notes: itemId, parent_settlement_id: null }) }
        if (sellerShipping !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: sellerShipping, gross_amount: null, merchant: 'Mercari Seller Shipping', type: 'other', source: 'csv_import', platform: 'mercari', schedule_c_category: 'shipping_postage', record_type: 'transaction', csv_transaction_id: `mercari_${safeId}_seller_ship`, csv_group_id: groupId, notes: itemId, parent_settlement_id: null }) }
        if (mercariSellingFee !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: mercariSellingFee, gross_amount: null, merchant: 'Mercari Selling Fee', type: 'other', source: 'csv_import', platform: 'mercari', schedule_c_category: 'commissions_fees', record_type: 'transaction', csv_transaction_id: `mercari_${safeId}_selling_fee`, csv_group_id: groupId, notes: itemId, parent_settlement_id: null }) }
        if (processingFee !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: processingFee, gross_amount: null, merchant: 'Mercari Processing Fee', type: 'other', source: 'csv_import', platform: 'mercari', schedule_c_category: 'commissions_fees', record_type: 'transaction', csv_transaction_id: `mercari_${safeId}_processing_fee`, csv_group_id: groupId, notes: itemId, parent_settlement_id: null }) }
        if (shippingAdjFee !== 0) { rowsParsed++; transactions.push({ user_id: user.id, date, amount: shippingAdjFee, gross_amount: null, merchant: 'Mercari Shipping Adjustment', type: 'other', source: 'csv_import', platform: 'mercari', schedule_c_category: 'shipping_postage', record_type: 'transaction', csv_transaction_id: `mercari_${safeId}_ship_adj`, csv_group_id: groupId, notes: itemId, parent_settlement_id: null }) }
        if (itemPrice === 0 && buyerShipping === 0 && sellerShipping === 0 && mercariSellingFee === 0 && processingFee === 0 && shippingAdjFee === 0) trackSkip('all_zero')
      }

    // ──────────────────────────────
    // EBAY — Order Earnings Report → sales table (not transactions)
    // ──────────────────────────────
    } else if (platform === 'ebay_order_earnings') {
      let headerIdx = -1
      for (let i = 0; i < allRows.length; i++) {
        const norm = allRows[i].map(h => h.replace(/"/g, '').trim().toLowerCase())
        if (norm.includes('order creation date') && norm.includes('order earnings')) {
          headerIdx = i; break
        }
      }
      if (headerIdx === -1) {
        return json(400, { error: 'Could not find Order Earnings header row. Expected columns: "Order creation date" and "Order earnings". Use: Seller Hub → Reports → Order Earnings Report.' })
      }

      const header = allRows[headerIdx].map(h => h.replace(/"/g, '').trim())
      const col = (row: string[], name: string) => {
        const idx = header.findIndex(h => h.toLowerCase() === name.toLowerCase())
        return idx !== -1 ? (row[idx]?.replace(/"/g, '').trim() ?? '') : ''
      }

      // Group rows by Order number
      const orders = new Map<string, {
        date: string
        itemTitles: string[]
        totalQty: number
        grossAmount: number
        fees: Record<string, number>
        shippingLabels: number
        discount: number
        refunds: number
        orderEarnings: number
      }>()

      const FEE_COLS = [
        ['Final Value Fee - fixed', 'final_value_fee_fixed'],
        ['Final Value Fee - variable', 'final_value_fee_variable'],
        ['Promoted Listing Standard fee', 'promoted_listing_standard'],
        ['Regulatory operating fee', 'regulatory_operating'],
        ['International fee', 'international'],
        ['Below standard performance fee', 'below_standard_performance'],
        ['Very high item not as described fee', 'item_not_as_described'],
        ['Deposit processing fee', 'deposit_processing'],
        ['Payment Dispute Fee', 'payment_dispute'],
        ['Charity donation', 'charity_donation'],
      ] as const

      for (let i = headerIdx + 1; i < allRows.length; i++) {
        const r = allRows[i]
        const orderNumber = col(r, 'Order number')
        if (!orderNumber || orderNumber === '--') { trackSkip('no_order_number'); continue }

        const date = parseDateAny(col(r, 'Order creation date'))
        if (!date) { trackSkip('bad_date'); continue }

        const grossAmount = parseAmount(col(r, 'Gross amount'))
        const orderEarnings = parseAmount(col(r, 'Order earnings'))
        const qty = parseInt(col(r, 'Quantity')) || 1
        const itemTitle = col(r, 'Item title')
        const shippingLabels = Math.abs(parseAmount(col(r, 'Shipping labels')))
        const discount = Math.abs(parseAmount(col(r, 'Discount')))
        const refunds = Math.abs(parseAmount(col(r, 'Refunds')))

        const rowFees: Record<string, number> = {}
        for (const [csvName, key] of FEE_COLS) {
          rowFees[key] = Math.abs(parseAmount(col(r, csvName)))
        }

        const existing = orders.get(orderNumber)
        if (existing) {
          existing.itemTitles.push(itemTitle)
          existing.totalQty += qty
          existing.grossAmount += grossAmount
          for (const key of Object.keys(rowFees)) existing.fees[key] = (existing.fees[key] ?? 0) + rowFees[key]
          existing.shippingLabels += shippingLabels
          existing.discount += discount
          existing.refunds += refunds
          existing.orderEarnings += orderEarnings
        } else {
          orders.set(orderNumber, {
            date, itemTitles: [itemTitle], totalQty: qty, grossAmount,
            fees: { ...rowFees }, shippingLabels, discount, refunds, orderEarnings,
          })
        }
        rowsParsed++
      }

      // Build and upsert sales rows
      const salesRows: any[] = []
      for (const [orderNumber, e] of orders) {
        const feesTotal = Object.values(e.fees).reduce((s, v) => s + v, 0)
        const itemName = e.itemTitles.length === 1
          ? (e.itemTitles[0] || 'eBay Sale')
          : `${e.itemTitles[0]} + ${e.itemTitles.length - 1} more`

        salesRows.push({
          user_id: user.id,
          platform: 'ebay',
          source: 'ebay',
          external_order_id: orderNumber,
          item_name: itemName,
          quantity: e.totalQty,
          sale_price: e.grossAmount,
          fees: feesTotal,
          fee_breakdown: e.fees,
          shipping_cost: e.shippingLabels,
          discount: e.discount > 0 ? e.discount : null,
          net_payout: e.orderEarnings,
          refunded_amount: e.refunds > 0 ? e.refunds : 0,
          return_status: e.refunds > 0 ? (e.refunds >= e.grossAmount ? 'full' : 'partial') : 'none',
          sold_at: e.date,
          inventory_status: 'ok',
          refunded_quantity: 0,
        })
      }

      let salesUpserted = 0
      for (let i = 0; i < salesRows.length; i += BATCH) {
        const { error, count } = await supabase.from('sales')
          .upsert(salesRows.slice(i, i + BATCH), { onConflict: 'user_id,external_order_id' })
        if (error) console.error('Sales upsert error:', error)
        else salesUpserted += salesRows.slice(i, i + BATCH).length
      }

      return json(200, {
        success: true, platform: 'ebay_order_earnings',
        rows_parsed: rowsParsed, rows_skipped: rowsSkipped,
        skipped_breakdown: skippedTypes,
        sales_upserted: salesUpserted,
      })

    } else {
      return json(400, { error: `Unknown platform: ${platform}. Supported: ebay, ebay_order_earnings, amazon, mercari` })
    }

    for (let i = 0; i < transactions.length; i += BATCH) {
      const { error } = await supabase.from('transactions')
        .upsert(transactions.slice(i, i + BATCH), { onConflict: 'user_id,csv_transaction_id', ignoreDuplicates: true })
      if (error) console.error('Upsert error:', error)
    }

    return json(200, {
      success: true, platform,
      amazon_format: amazonFormat || undefined,
      rows_parsed: rowsParsed, rows_skipped: rowsSkipped,
      skipped_breakdown: skippedTypes,
    })

  } catch (error: any) {
    console.error('Import error:', error)
    return json(500, { error: error.message })
  }
})
