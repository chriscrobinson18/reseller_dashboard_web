import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from './fetchAll'
import type { TieOutSale, TieOutDeposit, IncomeDepositInput, EbaySaleInput, EbayCsvRowInput } from './tieOut'

/**
 * Data for the Year-End Tie-Out card (components/TieOutCard.tsx): one full tax
 * year of sales, settlement deposits, income-tagged deposits, and both eBay
 * sources (with a margin around the year). Every query is paged with
 * fetchAllRows (PostgREST caps responses at 1000 rows). Read-only. Takes the
 * client as a parameter so the exact queries can be run outside the browser.
 */
export const EBAY_WINDOW_DAYS = 45

const shiftDate = (iso: string, days: number) => {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface TieOutData {
  sales: TieOutSale[]
  deposits: TieOutDeposit[]
  incomeRows: IncomeDepositInput[]
  ebaySales: EbaySaleInput[]
  ebayCsv: EbayCsvRowInput[]
}

export async function fetchTieOutData(supabase: SupabaseClient, year: number): Promise<TieOutData> {
  const start = `${year}-01-01`, end = `${year}-12-31`, next = `${year + 1}-01-01`
  const wStart = shiftDate(start, -EBAY_WINDOW_DAYS), wEnd = shiftDate(end, EBAY_WINDOW_DAYS)
  const [sales, deposits, incomeRows, ebaySales, ebayCsv] = await Promise.all([
    fetchAllRows<TieOutSale>((from, to) => supabase.from('sales')
      .select('platform, sold_at, sale_price, fees, shipping_cost, shipping_charged, refunded_amount, net_payout, deleted_at, trade_id')
      .is('deleted_at', null)
      .gte('sold_at', `${start}T00:00:00Z`).lt('sold_at', `${next}T00:00:00Z`)
      .order('id').range(from, to)),
    // Settlement deposits: bank credits tagged settlement, not CSV audit rows.
    fetchAllRows<TieOutDeposit>((from, to) => supabase.from('transactions')
      .select('date, amount, platform')
      .or('record_type.eq.settlement,schedule_c_category.eq.settlement')
      .or('source.is.null,source.neq.csv_import')
      .gt('amount', 0)
      .gte('date', start).lte('date', end)
      .order('id').range(from, to)),
    fetchAllRows<IncomeDepositInput>((from, to) => supabase.from('transactions')
      .select('id, date, amount, merchant, schedule_c_category, record_type, source, related_sale_id, related_bundle_id, trade_id, net_zero_pair_id')
      .eq('schedule_c_category', 'payout')
      .gte('date', start).lte('date', end)
      .order('id').range(from, to)),
    // eBay sides are fetched with a margin so orders straddling New Year pair
    // up; compareEbaySources(…, year) keeps only this year's orders.
    fetchAllRows<EbaySaleInput>((from, to) => supabase.from('sales')
      .select('external_order_id, sold_at, sale_price, fees, shipping_cost, refunded_amount, deleted_at')
      .eq('platform', 'ebay').is('deleted_at', null)
      .gte('sold_at', `${wStart}T00:00:00Z`).lte('sold_at', `${wEnd}T23:59:59Z`)
      .order('id').range(from, to)),
    fetchAllRows<EbayCsvRowInput>((from, to) => supabase.from('transactions')
      .select('notes, date, amount, schedule_c_category')
      .eq('source', 'csv_import').eq('platform', 'ebay')
      .gte('date', wStart).lte('date', wEnd)
      .order('id').range(from, to)),
  ])
  return { sales, deposits, incomeRows, ebaySales, ebayCsv }
}
