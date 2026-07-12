import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Link2, Pencil, Trash2, RotateCcw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getPeriodRange, type PeriodPreset } from '../lib/periods'
import { formatUSD, formatDate } from '../lib/utils'
import { deleteSale } from '../lib/mutations'
import PeriodPicker from '../components/PeriodPicker'
import SlideOver from '../components/SlideOver'
import ConfirmDialog from '../components/ConfirmDialog'
import RecordSaleModal from '../components/modals/RecordSaleModal'
import EditSaleModal from '../components/modals/EditSaleModal'
import LinkSaleToItemModal from '../components/modals/LinkSaleToItemModal'
import ProcessReturnModal from '../components/modals/ProcessReturnModal'
import { saleProfit } from '../lib/saleProfit'
import type { Sale } from '../lib/types'
import TradeDetailSlideOver from '../components/TradeDetailSlideOver'

async function fetchSales(start: string | null, end: string | null): Promise<{
  sales: Sale[]
  netPayoutBySale: Record<string, number>
}> {
  let q = supabase
    .from('sales')
    .select(`
      *,
      items(id, name, category),
      inventory_movements(id, quantity, inventory_lots(unit_cost, item_id))
    `)
    .is('deleted_at', null)
    .order('sold_at', { ascending: false })
  if (start) q = q.gte('sold_at', start + 'T00:00:00Z')
  if (end) q = q.lte('sold_at', end + 'T23:59:59Z')
  const { data, error } = await q.limit(2000)
  if (error) throw error
  const sales = data ?? []

  // Net payout = sum of every transaction linked to the sale (payout, fees,
  // shipping, refund, return-shipping) — the true cash impact, including
  // any returns. Falls back to sale.net_payout for sales with no linked
  // transactions (e.g. CSV-imported sales, or sales missing fee/shipping).
  const saleIds = sales.map(s => s.id)
  let netPayoutBySale: Record<string, number> = {}
  if (saleIds.length > 0) {
    const { data: txns, error: txErr } = await supabase
      .from('transactions')
      .select('related_sale_id, amount')
      .in('related_sale_id', saleIds)
    if (txErr) throw txErr
    netPayoutBySale = (txns ?? []).reduce((acc, t) => {
      acc[t.related_sale_id!] = (acc[t.related_sale_id!] ?? 0) + t.amount
      return acc
    }, {} as Record<string, number>)
  }

  return { sales, netPayoutBySale }
}

function netPayoutFor(sale: Sale, netPayoutBySale: Record<string, number>): number {
  return netPayoutBySale[sale.id] ?? sale.net_payout ?? (sale.sale_price - (sale.fees ?? 0))
}

const PLATFORM_COLORS: Record<string, string> = {
  ebay: '#e53e3e', amazon: '#dd6b20', tcgplayer: '#5a67d8',
  mercari: '#d53f8c', stockx: '#22543d', goat: '#2d3748',
  manual: '#718096', other: '#718096',
}

function PlatformBadge({ platform }: { platform?: string | null }) {
  if (!platform) return <span className="text-gray-400 text-xs">—</span>
  const color = PLATFORM_COLORS[platform] ?? '#718096'
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize"
      style={{ backgroundColor: color + '18', color }}
    >
      {platform}
    </span>
  )
}

function StatusBadge({ status, type }: { status: string; type: 'inventory' | 'return' }) {
  if (type === 'inventory') {
    const map: Record<string, [string, string]> = {
      ok: ['bg-green-100 text-green-700', 'OK'],
      oversold: ['bg-red-100 text-red-700', 'Oversold'],
      reconciled: ['bg-gray-100 text-gray-600', 'Reconciled'],
    }
    const [cls, label] = map[status] ?? ['bg-gray-100 text-gray-600', status]
    return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>
  }
  if (status === 'none') return null
  const map: Record<string, [string, string]> = {
    partial: ['bg-amber-100 text-amber-700', 'Partial Return'],
    full: ['bg-red-100 text-red-700', 'Returned'],
  }
  const [cls, label] = map[status] ?? ['bg-gray-100 text-gray-600', status]
  return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>
}

// ─── Sale detail ──────────────────────────────────────────────────────────────

function SaleDetail({ sale, netPayoutBySale, onLinkItem, onEdit, onDelete, onProcessReturn, onOpenTrade }: {
  sale: Sale
  netPayoutBySale: Record<string, number>
  onLinkItem: () => void
  onEdit: () => void
  onDelete: () => void
  onProcessReturn: () => void
  onOpenTrade: (id: string) => void
}) {
  const { cogs, netRevenue, profit } = saleProfit(sale)
  const hasCogsData = (sale.inventory_movements?.length ?? 0) > 0
  const canReturn = !sale.trade_id
  const netPayout = netPayoutFor(sale, netPayoutBySale)

  return (
    <div className="space-y-4">
      {/* Trade banner */}
      {sale.trade_id && (
        <div className="mb-3 p-2.5 rounded-lg bg-purple-50 border border-purple-200 text-xs text-purple-800">
          This sale is part of a trade. Edit or delete it from the trade.
          <button
            type="button"
            onClick={() => { onOpenTrade(sale.trade_id!) }}
            className="ml-2 underline font-medium"
          >
            Open trade
          </button>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={onEdit}
          disabled={!!sale.trade_id}
          title={sale.trade_id ? 'Locked — part of a trade. Open the trade to delete.' : undefined}
          className="flex-1 flex items-center justify-center gap-1.5 border border-gray-200 rounded-lg py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Pencil size={13} /> Edit
        </button>
        <button
          onClick={onDelete}
          disabled={!!sale.trade_id}
          title={sale.trade_id ? 'Locked — part of a trade. Open the trade to delete.' : undefined}
          className="flex items-center justify-center gap-1.5 border border-red-200 text-red-600 rounded-lg py-2 px-3 text-sm font-medium hover:bg-red-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Trash2 size={13} /> Delete
        </button>
      </div>

      {canReturn && (
        <button
          onClick={onProcessReturn}
          className="w-full flex items-center justify-center gap-1.5 border border-amber-200 text-amber-700 rounded-lg py-2 text-sm font-medium hover:bg-amber-50 transition-colors"
        >
          <RotateCcw size={13} /> {sale.return_status === 'none' ? 'Process Return' : 'Edit Return'}
        </button>
      )}

      {/* Header */}
      <div className="bg-gray-50 rounded-xl p-4">
        <div className="text-2xl font-bold text-gray-900 tabular-nums">{formatUSD(sale.sale_price)}</div>
        <div className="text-sm font-medium text-gray-700 mt-1">
          {sale.items?.name ?? <span className="text-gray-400 italic">Unlinked sale</span>}
        </div>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <PlatformBadge platform={sale.platform} />
          <StatusBadge status={sale.inventory_status} type="inventory" />
          <StatusBadge status={sale.return_status} type="return" />
        </div>
      </div>

      {/* Link to item CTA when unlinked */}
      {!sale.item_id && (
        <button
          onClick={onLinkItem}
          className="w-full flex items-center justify-center gap-1.5 border border-amber-300 bg-amber-50 text-amber-700 rounded-lg py-2 text-sm font-medium hover:bg-amber-100 transition-colors"
        >
          <Link2 size={14} /> Link to inventory item
        </button>
      )}

      {/* Sale metrics */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {[
          { label: 'Date', value: formatDate(sale.sold_at) },
          { label: 'Quantity', value: String(sale.quantity) },
          { label: 'Platform Fees', value: formatUSD(sale.fees ?? 0) },
          { label: 'Shipping', value: sale.shipping_cost != null ? formatUSD(sale.shipping_cost) : '—' },
          { label: 'Net Payout', value: formatUSD(netPayout), negative: netPayout < 0 },
          { label: 'Order ID', value: sale.external_order_id || '—' },
        ].map(({ label, value, negative }) => (
          <div key={label} className="bg-gray-50 rounded-lg p-2.5">
            <div className="text-gray-400 mb-0.5">{label}</div>
            <div className={`font-medium ${negative ? 'text-red-500' : 'text-gray-800'}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Return info */}
      {sale.return_status !== 'none' && (
        <div className="bg-red-50 border border-red-100 rounded-xl p-3 text-xs">
          <div className="font-semibold text-red-700 mb-1">Return</div>
          <div className="text-red-600">
            Qty: {sale.refunded_quantity} · Amount: {formatUSD(sale.refunded_amount ?? 0)}
          </div>
        </div>
      )}

      {/* Inventory movements (COGS) */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Inventory Used (FIFO)
        </div>
        {(sale.inventory_movements?.length ?? 0) === 0 ? (
          <div className="text-xs text-gray-400 bg-gray-50 rounded-lg p-3">
            No inventory movements recorded.
            {sale.inventory_status === 'oversold' && (
              <span className="text-red-500 ml-1">Sale was oversold.</span>
            )}
          </div>
        ) : (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-3 py-2 text-gray-500 font-medium">Qty Used</th>
                  <th className="text-right px-3 py-2 text-gray-500 font-medium">Unit Cost</th>
                  <th className="text-right px-3 py-2 text-gray-500 font-medium">COGS</th>
                </tr>
              </thead>
              <tbody>
                {(sale.inventory_movements ?? []).map(m => (
                  <tr key={m.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2 text-gray-700">{m.quantity}</td>
                    <td className="px-3 py-2 text-gray-700 text-right tabular-nums">
                      {m.inventory_lots ? formatUSD(m.inventory_lots.unit_cost) : '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-900 font-medium text-right tabular-nums">
                      {m.inventory_lots ? formatUSD(m.quantity * m.inventory_lots.unit_cost) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Profitability */}
      {hasCogsData && (
        <div className="bg-gray-50 rounded-xl p-4">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Profitability</div>
          {[
            { label: 'Revenue', value: netRevenue },
            { label: 'COGS', value: -cogs },
            { label: 'Fees', value: -(sale.fees ?? 0) },
            { label: 'Shipping', value: -(sale.shipping_cost ?? 0) },
          ].map(({ label, value }) => (
            <div key={label} className="flex justify-between py-0.5 text-xs">
              <span className="text-gray-600">{label}</span>
              <span className={`tabular-nums font-medium ${value < 0 ? 'text-red-500' : 'text-gray-800'}`}>
                {formatUSD(value)}
              </span>
            </div>
          ))}
          <div className="flex justify-between pt-2 border-t border-gray-200 mt-1 text-sm">
            <span className="font-semibold text-gray-900">Net Profit</span>
            <span className={`font-bold tabular-nums ${profit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {formatUSD(profit)}
            </span>
          </div>
          {netRevenue > 0 && (
            <div className="text-xs text-gray-400 text-right mt-0.5">
              {((profit / netRevenue) * 100).toFixed(1)}% margin
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [period, setPeriod] = useState<PeriodPreset>('ytd')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Sale | null>(null)
  const [showRecordSale, setShowRecordSale] = useState(false)
  const [linkSale, setLinkSale] = useState<Sale | null>(null)
  const [editSale, setEditSale] = useState<Sale | null>(null)
  const [returnSale, setReturnSale] = useState<Sale | null>(null)
  const [deleteSaleTarget, setDeleteSaleTarget] = useState<Sale | null>(null)
  const [openTradeId, setOpenTradeId] = useState<string | null>(null)
  const qc = useQueryClient()
  const range = getPeriodRange(period)

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSale(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      setDeleteSaleTarget(null)
      setSelected(null)
    },
  })

  const { data: { sales, netPayoutBySale } = { sales: [], netPayoutBySale: {} }, isLoading } = useQuery({
    queryKey: ['sales', range.start, range.end],
    queryFn: () => fetchSales(range.start, range.end),
  })

  const filtered = useMemo(() => {
    if (!search) return sales
    const q = search.toLowerCase()
    return sales.filter(s =>
      (s.items?.name ?? '').toLowerCase().includes(q) ||
      (s.external_order_id ?? '').toLowerCase().includes(q) ||
      (s.platform ?? '').toLowerCase().includes(q)
    )
  }, [sales, search])

  const totalRevenue = filtered
    .filter(s => s.return_status !== 'full')
    .reduce((sum, s) => {
      const refund = s.return_status === 'partial' ? (s.refunded_amount ?? 0) : 0
      return sum + s.sale_price - refund
    }, 0)

  const needsLink = filtered.filter(s => !s.item_id).length

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-6 border-b border-gray-200 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold text-gray-900">Sales</h1>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-500">{formatUSD(totalRevenue)} revenue</span>
              {needsLink > 0 && (
                <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full text-xs font-medium">
                  {needsLink} need inventory link
                </span>
              )}
            </div>
          </div>
          <PeriodPicker value={period} onChange={setPeriod} />
          <div className="flex items-center justify-between">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search item, order ID, platform…"
              className="w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <button
              onClick={() => setShowRecordSale(true)}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
            >
              <Plus size={14} /> Record Sale
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-8 text-center text-gray-400 text-sm">Loading sales…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">No sales found.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-24">Date</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Item</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-24">Platform</th>
                  <th className="text-center px-4 py-2.5 text-xs font-medium text-gray-500 w-16">Qty</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500 w-24">Price</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500 w-24">Net Payout</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-24">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(sale => (
                  <tr
                    key={sale.id}
                    className={`data-row border-b border-gray-100 ${selected?.id === sale.id ? 'selected' : ''}`}
                    onClick={() => setSelected(sale)}
                  >
                    <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                      {sale.sold_at.slice(0, 10)}
                    </td>
                    <td className="px-4 py-2.5">
                      {sale.items?.name ? (
                        <>
                          <div className="font-medium text-gray-900 truncate max-w-xs">{sale.items.name}</div>
                          {sale.items.category && (
                            <div className="text-xs text-gray-400">{sale.items.category}</div>
                          )}
                        </>
                      ) : (
                        <button
                          onClick={e => { e.stopPropagation(); setLinkSale(sale) }}
                          className="flex items-center gap-1 text-amber-600 hover:text-amber-800 text-xs font-medium"
                        >
                          <Link2 size={12} /> Link to inventory item
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {sale.trade_id ? (
                        <span
                          className="inline-block px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 rounded cursor-pointer hover:bg-purple-200"
                          onClick={(e) => { e.stopPropagation(); setOpenTradeId(sale.trade_id!) }}
                        >
                          Trade
                        </span>
                      ) : (
                        <PlatformBadge platform={sale.platform} />
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center text-gray-700">{sale.quantity}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums text-gray-900">
                      {formatUSD(sale.sale_price)}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-medium tabular-nums ${netPayoutFor(sale, netPayoutBySale) < 0 ? 'text-red-500' : 'text-gray-700'}`}>
                      {formatUSD(netPayoutFor(sale, netPayoutBySale))}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex gap-1 flex-wrap">
                        <StatusBadge status={sale.inventory_status} type="inventory" />
                        <StatusBadge status={sale.return_status} type="return" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
          {filtered.length} sales
        </div>
      </div>

      <SlideOver open={!!selected} onClose={() => setSelected(null)} title="Sale Detail">
        {selected && (
          <SaleDetail
            key={selected.id}
            sale={selected}
            netPayoutBySale={netPayoutBySale}
            onLinkItem={() => setLinkSale(selected)}
            onEdit={() => setEditSale(selected)}
            onDelete={() => setDeleteSaleTarget(selected)}
            onProcessReturn={() => setReturnSale(selected)}
            onOpenTrade={(id) => { setSelected(null); setOpenTradeId(id) }}
          />
        )}
      </SlideOver>

      <RecordSaleModal open={showRecordSale} onClose={() => setShowRecordSale(false)} />
      {linkSale && (
        <LinkSaleToItemModal
          open={!!linkSale}
          onClose={() => setLinkSale(null)}
          sale={linkSale}
        />
      )}
      {editSale && (
        <EditSaleModal
          open={!!editSale}
          onClose={() => setEditSale(null)}
          sale={editSale}
        />
      )}
      {returnSale && (
        <ProcessReturnModal
          open={!!returnSale}
          onClose={() => setReturnSale(null)}
          sale={returnSale}
        />
      )}
      <ConfirmDialog
        open={!!deleteSaleTarget}
        title="Delete sale?"
        message="This removes the sale, restores any depleted inventory back to its original lots, and deletes the linked payout/fee/shipping transactions."
        loading={deleteMutation.isPending}
        onConfirm={() => deleteSaleTarget && deleteMutation.mutate(deleteSaleTarget.id)}
        onCancel={() => setDeleteSaleTarget(null)}
      />
      <TradeDetailSlideOver tradeId={openTradeId} onClose={() => setOpenTradeId(null)} />
    </div>
  )
}
