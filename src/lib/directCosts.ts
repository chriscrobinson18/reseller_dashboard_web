import { supabase } from './supabase'

/**
 * Costs attributed to sales for profit only (transactions.profit_sale_id):
 * sale id → total cost (positive). A refund attributed to the same sale nets
 * against it. Net-zero paired rows are left out (the charge was cancelled
 * out). This never feeds Schedule C; the charges stay ordinary expenses.
 * See docs/features/expenses.md "Attribute a charge to a sale".
 */
export async function fetchDirectCosts(saleIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < saleIds.length; i += 200) {
    const { data, error } = await supabase.from('transactions')
      .select('profit_sale_id, amount')
      .in('profit_sale_id', saleIds.slice(i, i + 200))
      .is('net_zero_pair_id', null)
    if (error) throw error
    for (const r of (data ?? []) as { profit_sale_id: string; amount: number }[]) {
      out.set(r.profit_sale_id, (out.get(r.profit_sale_id) ?? 0) - Number(r.amount))
    }
  }
  for (const [k, v] of out) out.set(k, Math.round(v * 100) / 100)
  return out
}
