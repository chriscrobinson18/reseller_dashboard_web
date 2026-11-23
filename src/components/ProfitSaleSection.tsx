import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShoppingCart } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { attributeTransactionToSale } from '../lib/mutations'
import { formatUSD, formatShortDate } from '../lib/utils'
import type { Transaction } from '../lib/types'

type SaleOption = {
  id: string; sold_at: string; sale_price: number; platform: string | null; external_order_id: string | null
  item_name: string | null; product_name: string | null; deleted_at: string | null; items: { name: string } | null
}
const SALE_SELECT = 'id, sold_at, sale_price, platform, external_order_id, item_name, product_name, deleted_at, items(name)'

const shift = (d: string, n: number) => {
  const t = new Date(d.slice(0, 10) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10)
}
const saleName = (s: SaleOption) => s.items?.name ?? s.item_name ?? s.product_name ?? 'Sale'

/**
 * Transaction panel: attribute this charge to a sale for PROFIT ONLY
 * (transactions.profit_sale_id), e.g. a shipping label paid with your own
 * card. The row stays an ordinary Schedule C expense; the sale's profit and
 * the Dashboard's Sales Profitability include it.
 */
export default function ProfitSaleSection({ tx }: { tx: Transaction }) {
  const qc = useQueryClient()
  const blocked = !!tx.related_sale_id || !!tx.related_bundle_id || tx.source === 'csv_import' || !!tx.trade_id || !!tx.net_zero_pair_id
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const { data: current } = useQuery({
    queryKey: ['sales', 'profit-attribution', tx.profit_sale_id],
    enabled: !!tx.profit_sale_id,
    queryFn: async () => {
      const { data, error } = await supabase.from('sales').select(SALE_SELECT).eq('id', tx.profit_sale_id!).maybeSingle()
      if (error) throw error
      return (data ?? null) as unknown as SaleOption | null
    },
  })

  // Sales from 90 days before to 14 days after the charge (labels are usually bought after the sale).
  const { data: sales = [], isLoading } = useQuery({
    queryKey: ['sales', 'profit-candidates', tx.id],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.from('sales').select(SALE_SELECT).is('deleted_at', null)
        .gte('sold_at', shift(tx.date, -90) + 'T00:00:00Z').lte('sold_at', shift(tx.date, 14) + 'T23:59:59Z')
        .order('sold_at', { ascending: false }).limit(500)
      if (error) throw error
      return (data ?? []) as unknown as SaleOption[]
    },
  })
  const shown = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
    return sales
      .filter(s => terms.every(t => `${saleName(s)} ${s.platform ?? ''} ${s.external_order_id ?? ''} ${Number(s.sale_price).toFixed(2)} ${s.sold_at.slice(0, 10)}`
        .toLowerCase().includes(t.replace(/[$,]/g, ''))))
      .slice(0, 30)
  }, [sales, search])

  const save = useMutation({
    mutationFn: (saleId: string | null) => attributeTransactionToSale(tx.id, saleId),
    onSuccess: () => {
      setErr(null); setOpen(false); setSearch('')
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['linked-records'] })
    },
    onError: (e: Error) => setErr(e.message),
  })

  if (blocked && !tx.profit_sale_id) return null

  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5 font-medium text-gray-500 mb-1.5">
        <ShoppingCart size={12} /> Sale profit
        {!open && !blocked && (
          <button type="button" onClick={() => setOpen(true)} className="ml-auto text-blue-600 hover:text-blue-800 font-medium">
            {tx.profit_sale_id ? 'Change sale' : 'Attribute to a sale'}
          </button>
        )}
      </div>

      {tx.profit_sale_id && !open && (
        <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-2 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-800 truncate">
              {current ? saleName(current) : 'Sale'}
              {current?.deleted_at && <span className="ml-1.5 text-red-500 font-normal">deleted</span>}
            </div>
            {current && <div className="text-gray-400">{formatShortDate(current.sold_at.slice(0, 10))} · {formatUSD(current.sale_price)}</div>}
          </div>
          <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending} className="text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50">
            Remove
          </button>
        </div>
      )}
      {!tx.profit_sale_id && !open && (
        <div className="text-gray-400">
          Paid this directly (e.g. a label on your own card) for one sale? Attribute it so that sale's profit includes it. Taxes are unchanged: it stays an expense on its own.
        </div>
      )}

      {open && (
        <div className="space-y-1.5">
          <input
            autoFocus value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search item, order #, price, date…"
            className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          {isLoading ? <div className="text-gray-400">Loading sales…</div>
            : shown.length === 0 ? <div className="text-gray-400">No sales from 90 days before to 14 days after this charge match.</div>
            : shown.map(s => (
              <button key={s.id} type="button" onClick={() => save.mutate(s.id)} disabled={save.isPending}
                className="w-full text-left flex items-center gap-2 border border-gray-200 rounded-lg px-2 py-1.5 hover:border-blue-300 hover:bg-blue-50/40 disabled:opacity-50">
                <span className="text-gray-500 tabular-nums shrink-0">{formatShortDate(s.sold_at.slice(0, 10))}</span>
                <span className="truncate font-medium text-gray-800">{saleName(s)}</span>
                <span className="text-gray-400 shrink-0">{s.platform ?? ''}</span>
                <span className="ml-auto tabular-nums shrink-0">{formatUSD(s.sale_price)}</span>
              </button>
            ))}
          <button type="button" onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-800">Cancel</button>
        </div>
      )}
      {err && <div className="text-red-600 mt-1">{err}</div>}
    </div>
  )
}
