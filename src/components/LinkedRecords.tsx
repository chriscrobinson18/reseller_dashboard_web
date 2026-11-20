import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ArrowUpRight, Link2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatUSD, formatShortDate } from '../lib/utils'
import { recordHref, type RecordKind } from '../lib/nav'

/**
 * "Linked records": every record connected to this one, each a jump link to
 * the page that owns it (opened via the deep-link params in lib/nav.ts).
 *
 *   lot         → purchase transactions, cost-adjustment transactions, sales
 *                 that consumed it, trade, breakdown it came from / went into
 *   sale        → lots it consumed, its transactions, bundle, trade
 *   transaction → lots it funds or adjusts, sale, bundle, trade, breakdown,
 *                 net-zero partner
 *   bundle      → its sales, their lots, its transactions
 *   trade       → sales (given), lots (received), transactions
 *   breakdown   → source lot, resulting lots, transaction
 */

interface Entry {
  kind: RecordKind
  id: string
  label: string
  sub?: string
  amount?: number | null
  deleted?: boolean
}
type Group = { title: string; entries: Entry[] }

type TxRow = { id: string; date: string; amount: number; merchant: string | null; schedule_c_category: string | null }
type SaleRow = { id: string; sold_at: string; sale_price: number | null; quantity: number | null; item_name: string | null; product_name: string | null; platform: string | null; deleted_at: string | null; bundle_id: string | null; trade_id: string | null; items: { name: string } | null }
type LotRow = { id: string; purchase_date: string | null; created_at: string; quantity_purchased: number; quantity_remaining: number; unit_cost: number; deleted_at: string | null; trade_id: string | null; box_opening_id: string | null; items: { name: string } | null }

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))]

async function rows<T>(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await p
  if (error) throw error
  return (data ?? []) as T[]
}

async function txByIds(ids: string[]): Promise<TxRow[]> {
  if (!ids.length) return []
  return rows<TxRow>(supabase.from('transactions').select('id, date, amount, merchant, schedule_c_category').in('id', ids).order('date'))
}
async function salesByIds(ids: string[]): Promise<SaleRow[]> {
  if (!ids.length) return []
  return rows<SaleRow>(supabase.from('sales').select('id, sold_at, sale_price, quantity, item_name, product_name, platform, deleted_at, bundle_id, trade_id, items(name)').in('id', ids).order('sold_at'))
}
const LOT_SELECT = 'id, purchase_date, created_at, quantity_purchased, quantity_remaining, unit_cost, deleted_at, trade_id, box_opening_id, items(name)'
async function lotsByIds(ids: string[]): Promise<LotRow[]> {
  if (!ids.length) return []
  return rows<LotRow>(supabase.from('inventory_lots').select(LOT_SELECT).in('id', ids).order('purchase_date'))
}
async function lotIdsForSales(saleIds: string[]): Promise<string[]> {
  if (!saleIds.length) return []
  const m = await rows<{ inventory_lot_id: string }>(supabase.from('inventory_movements').select('inventory_lot_id').in('sale_id', saleIds))
  return uniq(m.map(r => r.inventory_lot_id))
}

const txEntry = (t: TxRow): Entry => ({ kind: 'transaction', id: t.id, label: t.merchant ?? 'Transaction', sub: formatShortDate(t.date), amount: t.amount })
const saleEntry = (s: SaleRow): Entry => ({
  kind: 'sale', id: s.id, label: s.items?.name ?? s.item_name ?? s.product_name ?? 'Sale',
  sub: [formatShortDate(s.sold_at.slice(0, 10)), s.platform, (s.quantity ?? 1) > 1 ? `qty ${s.quantity}` : null].filter(Boolean).join(' · '),
  amount: s.sale_price, deleted: !!s.deleted_at,
})
const lotEntry = (l: LotRow): Entry => ({
  kind: 'lot', id: l.id, label: l.items?.name ?? 'Inventory lot',
  sub: `${formatShortDate((l.purchase_date ?? l.created_at).slice(0, 10))} · ${l.quantity_remaining}/${l.quantity_purchased} left · ${formatUSD(l.unit_cost)} ea`,
  amount: -(l.quantity_purchased * l.unit_cost), deleted: !!l.deleted_at,
})

async function loadGroups(kind: RecordKind, id: string): Promise<Group[]> {
  const g: Group[] = []
  const add = (title: string, entries: Entry[]) => { if (entries.length) g.push({ title, entries }) }

  if (kind === 'lot') {
    const [lot] = await lotsByIds([id])
    const links = await rows<{ transaction_id: string }>(supabase.from('inventory_lot_transactions').select('transaction_id').eq('lot_id', id))
    const adj = await rows<{ transaction_id: string | null }>(supabase.from('lot_cost_adjustments').select('transaction_id').eq('lot_id', id).is('deleted_at', null))
    const moves = await rows<{ sale_id: string | null }>(supabase.from('inventory_movements').select('sale_id').eq('inventory_lot_id', id))
    const boxesFrom = await rows<{ id: string; opened_at: string | null; box_name: string | null }>(supabase.from('box_openings').select('id, opened_at, box_name').eq('source_lot_id', id).is('deleted_at', null))
    add('Purchase transactions', (await txByIds(uniq(links.map(l => l.transaction_id)))).map(txEntry))
    add('Cost adjustments', (await txByIds(uniq(adj.map(a => a.transaction_id)))).map(txEntry))
    add('Sales from this lot', (await salesByIds(uniq(moves.map(m => m.sale_id)))).map(saleEntry))
    if (lot?.trade_id) add('Trade', [{ kind: 'trade', id: lot.trade_id, label: 'Received in trade' }])
    if (lot?.box_opening_id) add('Breakdown', [{ kind: 'breakdown', id: lot.box_opening_id, label: 'Created by breakdown' }])
    add('Broken down into', boxesFrom.map(b => ({ kind: 'breakdown' as const, id: b.id, label: b.box_name ?? 'Breakdown', sub: b.opened_at ? formatShortDate(b.opened_at) : undefined })))
  }

  if (kind === 'sale') {
    const [sale] = await salesByIds([id])
    add('Inventory lots used', (await lotsByIds(await lotIdsForSales([id]))).map(lotEntry))
    add('Transactions', (await rows<TxRow>(supabase.from('transactions').select('id, date, amount, merchant, schedule_c_category').eq('related_sale_id', id).order('date'))).map(txEntry))
    if (sale?.bundle_id) add('Bundle', [{ kind: 'bundle', id: sale.bundle_id, label: 'Part of a bundle sale' }])
    if (sale?.trade_id) add('Trade', [{ kind: 'trade', id: sale.trade_id, label: 'Given in a trade' }])
  }

  if (kind === 'transaction') {
    const [tx] = await rows<{ related_sale_id: string | null; related_bundle_id: string | null; trade_id: string | null; net_zero_pair_id: string | null }>(
      supabase.from('transactions').select('related_sale_id, related_bundle_id, trade_id, net_zero_pair_id').eq('id', id))
    const links = await rows<{ lot_id: string }>(supabase.from('inventory_lot_transactions').select('lot_id').eq('transaction_id', id))
    const adj = await rows<{ lot_id: string }>(supabase.from('lot_cost_adjustments').select('lot_id').eq('transaction_id', id).is('deleted_at', null))
    const boxes = await rows<{ id: string; opened_at: string | null; box_name: string | null }>(supabase.from('box_openings').select('id, opened_at, box_name').eq('transaction_id', id).is('deleted_at', null))
    add('Funds inventory lots', (await lotsByIds(uniq(links.map(l => l.lot_id)))).map(lotEntry))
    add('Cost adjustment on lots', (await lotsByIds(uniq(adj.map(a => a.lot_id)))).map(lotEntry))
    if (tx?.related_sale_id) add('Sale', (await salesByIds([tx.related_sale_id])).map(saleEntry))
    if (tx?.related_bundle_id) add('Bundle', [{ kind: 'bundle', id: tx.related_bundle_id, label: 'Bundle sale' }])
    if (tx?.trade_id) add('Trade', [{ kind: 'trade', id: tx.trade_id, label: 'Trade' }])
    add('Breakdowns', boxes.map(b => ({ kind: 'breakdown' as const, id: b.id, label: b.box_name ?? 'Breakdown', sub: b.opened_at ? formatShortDate(b.opened_at) : undefined })))
    if (tx?.net_zero_pair_id) {
      add('Net-zero partner', (await rows<TxRow>(supabase.from('transactions').select('id, date, amount, merchant, schedule_c_category')
        .eq('net_zero_pair_id', tx.net_zero_pair_id).neq('id', id))).map(txEntry))
    }
  }

  if (kind === 'bundle') {
    const sales = await rows<SaleRow>(supabase.from('sales').select('id, sold_at, sale_price, quantity, item_name, product_name, platform, deleted_at, bundle_id, trade_id, items(name)').eq('bundle_id', id).order('sold_at'))
    add('Sales in this bundle', sales.map(saleEntry))
    add('Inventory lots used', (await lotsByIds(await lotIdsForSales(sales.map(s => s.id)))).map(lotEntry))
    add('Transactions', (await rows<TxRow>(supabase.from('transactions').select('id, date, amount, merchant, schedule_c_category').eq('related_bundle_id', id).order('date'))).map(txEntry))
  }

  if (kind === 'trade') {
    add('Sales (given)', (await rows<SaleRow>(supabase.from('sales').select('id, sold_at, sale_price, quantity, item_name, product_name, platform, deleted_at, bundle_id, trade_id, items(name)').eq('trade_id', id).order('sold_at'))).map(saleEntry))
    add('Lots (received)', (await rows<LotRow>(supabase.from('inventory_lots').select(LOT_SELECT).eq('trade_id', id).order('purchase_date'))).map(lotEntry))
    add('Transactions', (await rows<TxRow>(supabase.from('transactions').select('id, date, amount, merchant, schedule_c_category').eq('trade_id', id).order('date'))).map(txEntry))
  }

  if (kind === 'breakdown') {
    const [box] = await rows<{ source_lot_id: string | null; transaction_id: string | null }>(supabase.from('box_openings').select('source_lot_id, transaction_id').eq('id', id))
    if (box?.source_lot_id) add('Source lot', (await lotsByIds([box.source_lot_id])).map(lotEntry))
    add('Resulting lots', (await rows<LotRow>(supabase.from('inventory_lots').select(LOT_SELECT).eq('box_opening_id', id).order('created_at'))).map(lotEntry))
    if (box?.transaction_id) add('Purchase transaction', (await txByIds([box.transaction_id])).map(txEntry))
  }

  return g
}

/**
 * `onNavigate` closes whatever panel this sits in before jumping (the jump
 * itself is a normal navigation; Cmd/Ctrl-click opens a new tab).
 */
export default function LinkedRecords({ kind, id, onNavigate, max = 12 }: {
  kind: RecordKind
  id: string
  onNavigate?: () => void
  max?: number
}) {
  const navigate = useNavigate()
  const { data: groups = [], isLoading, error } = useQuery({
    queryKey: ['linked-records', kind, id],
    queryFn: () => loadGroups(kind, id),
  })

  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500 mb-1.5">
        <Link2 size={12} /> Linked records
      </div>
      {isLoading ? (
        <div className="text-xs text-gray-400">Loading…</div>
      ) : error ? (
        <div className="text-xs text-red-600">{(error as Error).message}</div>
      ) : groups.length === 0 ? (
        <div className="text-xs text-gray-400">Nothing linked.</div>
      ) : (
        <div className="space-y-2.5">
          {groups.map(gr => (
            <div key={gr.title}>
              <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{gr.title}</div>
              <div className="space-y-1">
                {gr.entries.slice(0, max).map(e => {
                  const href = recordHref(e.kind, e.id)
                  const body = (
                    <>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-gray-800 truncate">
                          {e.label}{e.deleted && <span className="ml-1.5 text-[10px] font-normal text-red-500">deleted</span>}
                        </div>
                        {e.sub && <div className="text-[11px] text-gray-400 truncate">{e.sub}</div>}
                      </div>
                      {e.amount != null && (
                        <span className={`text-xs tabular-nums shrink-0 ${e.amount < 0 ? 'text-gray-700' : 'text-emerald-600'}`}>{formatUSD(e.amount)}</span>
                      )}
                      {!e.deleted && <ArrowUpRight size={13} className="text-gray-400 group-hover:text-blue-600 shrink-0" />}
                    </>
                  )
                  return e.deleted ? (
                    <div key={e.kind + e.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-dashed border-gray-200 opacity-60" title="Deleted: nothing to open">
                      {body}
                    </div>
                  ) : (
                    <a
                      key={e.kind + e.id}
                      href={href}
                      onClick={ev => {
                        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return
                        ev.preventDefault()
                        onNavigate?.()
                        navigate(href)
                      }}
                      className="group flex items-center gap-2 px-2 py-1.5 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50/40 transition-colors"
                    >
                      {body}
                    </a>
                  )
                })}
                {gr.entries.length > max && <div className="text-[11px] text-gray-400 px-2">+{gr.entries.length - max} more</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
