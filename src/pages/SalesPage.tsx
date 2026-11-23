import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Link2, Pencil, Trash2, RotateCcw } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getPeriodRange, type PeriodPreset } from '../lib/periods'
import { formatUSD, formatDate } from '../lib/utils'
import { deleteSale } from '../lib/mutations'
import PeriodPicker from '../components/PeriodPicker'
import SlideOver from '../components/SlideOver'
import { ReviewBadge, ReviewControl } from '../components/ReviewMarker'
import ConfirmDialog from '../components/ConfirmDialog'
import RecordSaleModal from '../components/modals/RecordSaleModal'
import BundleDetailSlideOver from '../components/BundleDetailSlideOver'
import EditSaleModal from '../components/modals/EditSaleModal'
import LinkSaleToItemModal from '../components/modals/LinkSaleToItemModal'
import ProcessReturnModal from '../components/modals/ProcessReturnModal'
import { saleProfit } from '../lib/saleProfit'
import { paymentMethodLabel, formatPaymentSplits } from '../lib/paymentMethods'
import type { Sale } from '../lib/types'
import { fetchAllRows } from '../lib/fetchAll'
import { fetchDirectCosts } from '../lib/directCosts'
import LinkedRecords from '../components/LinkedRecords'
import { useDeepLink } from '../lib/nav'
import TradeDetailSlideOver from '../components/TradeDetailSlideOver'

const FEE_LABELS: Record<string, string> = {
  final_value_fee_fixed: 'FVF (fixed)',
  final_value_fee_variable: 'FVF (variable)',
  promoted_listing_standard: 'Promoted Listing',
  regulatory_operating: 'Regulatory',
  international: 'International',
  below_standard_performance: 'Below Standard',
  item_not_as_described: 'INAD Fee',
  deposit_processing: 'Deposit Processing',
  payment_dispute: 'Payment Dispute',
  charity_donation: 'Charity',
}

/**
 * One sale by id, for a ?sale= deep link outside the selected period. A bundle
 * line is fetched with its whole bundle so the fee allocation matches the list.
 */
async function fetchSaleById(id: string): Promise<{ sale: Sale | null; netPayoutBySale: Record<string, number> }> {
  const { data, error } = await supabase.from('sales').select('bundle_id').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) return { sale: null, netPayoutBySale: {} }
  const r = await fetchSales(null, null, data.bundle_id ? { bundleId: data.bundle_id } : { id })
  return { sale: r.sales.find(s => s.id === id) ?? null, netPayoutBySale: r.netPayoutBySale }
}

/**
 * A sale needs an inventory link when no lot units were taken for it. Gating on
 * item_id alone missed sales linked before 2026-11-12, when linking only set
 * item_id and never depleted lots. A fully returned sale has had its movements
 * reversed on purpose, so it doesn't need one.
 */
function needsInventoryLink(sale: Sale): boolean {
  return (sale.inventory_movements?.length ?? 0) === 0 && sale.return_status !== 'full'
}

async function fetchSales(start: string | null, end: string | null, narrow?: { id?: string; bundleId?: string }): Promise<{
  sales: Sale[]
  netPayoutBySale: Record<string, number>
}> {
  // Paged: PostgREST silently caps each response at 1000 rows (src/lib/fetchAll.ts).
  const sales = await fetchAllRows<Sale>((from, to) => {
    let q = supabase
      .from('sales')
      .select(`
        *,
        items(id, name, category),
        inventory_movements(id, quantity, inventory_lots(unit_cost, item_id))
      `)
      .is('deleted_at', null)
      .order('sold_at', { ascending: false })
      .order('id')
    if (start) q = q.gte('sold_at', start + 'T00:00:00Z')
    if (end) q = q.lte('sold_at', end + 'T23:59:59Z')
    if (narrow?.bundleId) q = q.eq('bundle_id', narrow.bundleId)
    else if (narrow?.id) q = q.eq('id', narrow.id)
    return q.range(from, to)
  })

  // Net payout = sum of every transaction linked to the sale (payout, fees,
  // shipping, refund, return-shipping) — the true cash impact, including
  // any returns. Falls back to sale.net_payout for sales with no linked
  // transactions (e.g. CSV-imported sales, or sales missing fee/shipping).
  const saleIds = sales.map(s => s.id)
  let netPayoutBySale: Record<string, number> = {}
  if (saleIds.length > 0) {
    const txns = await fetchAllRows<{ related_sale_id: string | null; amount: number }>((from, to) => supabase
      .from('transactions')
      .select('related_sale_id, amount')
      .in('related_sale_id', saleIds)
      .order('id')
      .range(from, to))
    netPayoutBySale = txns.reduce((acc, t) => {
      acc[t.related_sale_id!] = (acc[t.related_sale_id!] ?? 0) + t.amount
      return acc
    }, {} as Record<string, number>)
  }

  // Bundle lines are stamped fees=0/shipping=null because an order-level charge
  // can't belong to any one line. Without allocating it back, every bundle line
  // reports profit as though the order cost nothing to sell. Split proportionally
  // by line price: a $100 line in a $200 order bears half the fee.
  const bundleIds = [...new Set(sales.map(s => s.bundle_id).filter(Boolean))] as string[]
  if (bundleIds.length > 0) {
    const { data: bundles, error: bErr } = await supabase
      .from('sale_bundles')
      .select('id, fees, shipping_cost')
      .in('id', bundleIds)
    if (bErr) throw bErr

    const grossByBundle: Record<string, number> = {}
    for (const s of sales) {
      if (s.bundle_id) grossByBundle[s.bundle_id] = (grossByBundle[s.bundle_id] ?? 0) + s.sale_price
    }

    const byId = new Map((bundles ?? []).map(b => [b.id, b]))
    for (const s of sales) {
      const b = s.bundle_id ? byId.get(s.bundle_id) : null
      if (!b) continue
      const gross = grossByBundle[s.bundle_id!] ?? 0
      const share = gross > 0 ? s.sale_price / gross : 0
      s.allocated_fees = (Number(b.fees) || 0) * share
      s.allocated_shipping = (Number(b.shipping_cost) || 0) * share
      // Same reason the Net column can't use netPayoutBySale here: a bundle's
      // transactions carry related_bundle_id, so the related_sale_id lookup
      // above finds nothing and would silently fall back to the gross price.
      netPayoutBySale[s.id] = s.sale_price - s.allocated_fees - s.allocated_shipping
    }
  }

  // Charges paid directly and attributed to a sale (profit only).
  const direct = await fetchDirectCosts(sales.map(s => s.id))
  for (const s of sales) { const d = direct.get(s.id); if (d) s.direct_costs = d }

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

function StatusBadge({ status, type }: { status: string | null; type: 'inventory' | 'return' }) {
  if (type === 'inventory') {
    const map: Record<string, [string, string]> = {
      ok: ['bg-green-100 text-green-700', 'OK'],
      oversold: ['bg-red-100 text-red-700', 'Oversold'],
      reconciled: ['bg-gray-100 text-gray-600', 'Reconciled'],
    }
    const [cls, label] = map[status ?? ''] ?? ['bg-gray-100 text-gray-600', status]
    return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>
  }
  if (status === 'none' || status === null) return null
  const map: Record<string, [string, string]> = {
    partial: ['bg-amber-100 text-amber-700', 'Partial Return'],
    full: ['bg-red-100 text-red-700', 'Returned'],
  }
  const [cls, label] = map[status] ?? ['bg-gray-100 text-gray-600', status]
  return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>
}

// ─── Sale detail ──────────────────────────────────────────────────────────────

function SaleDetail({ sale, netPayoutBySale, onLinkItem, onEdit, onDelete, onProcessReturn, onOpenTrade, onOpenBundle, onNavigate }: {
  sale: Sale
  netPayoutBySale: Record<string, number>
  onLinkItem: () => void
  onEdit: () => void
  onDelete: () => void
  onProcessReturn: () => void
  onOpenTrade: (id: string) => void
  onOpenBundle: (id: string) => void
  onNavigate: () => void
}) {
  const { cogs, netRevenue, directCosts, profit } = saleProfit(sale)
  const hasCogsData = (sale.inventory_movements?.length ?? 0) > 0
  const canReturn = !sale.trade_id
  const netPayout = netPayoutFor(sale, netPayoutBySale)
  // Bundle lines are stamped fees=0/shipping=null (the real charge sits once on
  // the bundle) — same allocated-share fallback saleProfit() uses internally,
  // so the displayed breakdown actually matches the Net Profit total below it.
  const displayFees = sale.allocated_fees ?? sale.fees ?? 0
  const displayShipping = sale.allocated_shipping ?? sale.shipping_cost ?? null

  return (
    <div className="space-y-4">
      <ReviewControl table="sales" id={sale.id} status={sale.review_status} reviewedAt={sale.reviewed_at} invalidate={[['sales'], ['items']]} />

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

      {/* Bundle banner — informational only; unlike trades, a bundle line's
          price/return can still be edited independently since it isn't a
          barter leg with an FMV constraint. */}
      {sale.bundle_id && !sale.trade_id && (
        <div className="mb-3 p-2.5 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-800">
          This item was sold as part of a bundle. Fees and shipping apply to the whole order.
          <button
            type="button"
            onClick={() => { onOpenBundle(sale.bundle_id!) }}
            className="ml-2 underline font-medium"
          >
            Open bundle
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
          {sale.items?.name ?? sale.item_name ?? <span className="text-gray-400 italic">Unlinked sale</span>}
        </div>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <PlatformBadge platform={sale.platform} />
          {paymentMethodLabel(sale.payment_method) && (
            <span className="text-xs px-2 py-0.5 rounded-full border border-gray-200 text-gray-600">
              {sale.payments?.length ? `Split: ${formatPaymentSplits(sale.payments)}` : paymentMethodLabel(sale.payment_method)}
            </span>
          )}
          {sale.bundle_id && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">Bundle</span>
          )}
          <StatusBadge status={sale.inventory_status} type="inventory" />
          <StatusBadge status={sale.return_status} type="return" />
        </div>
      </div>

      {/* Link to item CTA when no lot units were taken for the sale */}
      {needsInventoryLink(sale) && (
        <button
          onClick={onLinkItem}
          className="w-full flex items-center justify-center gap-1.5 border border-amber-300 bg-amber-50 text-amber-700 rounded-lg py-2 text-sm font-medium hover:bg-amber-100 transition-colors"
        >
          <Link2 size={14} /> {sale.item_id ? 'Link to inventory lots' : 'Link to inventory item'}
        </button>
      )}

      {/* Sale metrics */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {[
          { label: 'Date', value: formatDate(sale.sold_at) },
          { label: 'Quantity', value: String(sale.quantity) },
          { label: 'Platform Fees', value: formatUSD(displayFees) },
          { label: 'Shipping', value: displayShipping != null ? formatUSD(displayShipping) : '—' },
          ...(sale.discount ? [{ label: 'Discount', value: formatUSD(sale.discount) }] : []),
          { label: 'Net Payout', value: formatUSD(netPayout), negative: netPayout < 0 },
          { label: 'Order ID', value: sale.external_order_id || '—' },
        ].map(({ label, value, negative }) => (
          <div key={label} className="bg-gray-50 rounded-lg p-2.5">
            <div className="text-gray-400 mb-0.5">{label}</div>
            <div className={`font-medium break-words ${negative ? 'text-red-500' : 'text-gray-800'}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Return info */}
      {(sale.return_status === 'full' || sale.return_status === 'partial') && (
        <div className="bg-red-50 border border-red-100 rounded-xl p-3 text-xs">
          <div className="font-semibold text-red-700 mb-1">Return</div>
          <div className="text-red-600">
            {/* Platform imports set the refund but not a quantity (no in-app return row). */}
            Qty: {sale.refunded_quantity
              ? sale.refunded_quantity
              : sale.return_status === 'full' ? `${sale.quantity} (all, from platform report)` : 'not recorded (from platform report)'}
            {' · '}Amount: {formatUSD(sale.refunded_amount ?? 0)}
          </div>
          {(sale.refunded_amount ?? 0) > sale.sale_price + 0.005 && (
            <div className="text-red-700 font-medium mt-1">Refund is more than the sale price: check it isn't counted twice.</div>
          )}
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
      {hasCogsData && (() => {
        const feeLines = sale.fee_breakdown
          ? Object.entries(sale.fee_breakdown)
              .filter(([, v]) => v !== 0)
              .map(([key, value]) => ({ label: FEE_LABELS[key] ?? key.replace(/_/g, ' '), value: -Math.abs(value) }))
          : [{ label: 'Fees', value: -displayFees }]

        const profitLines = [
          { label: 'Revenue', value: netRevenue },
          { label: 'COGS', value: -cogs },
          ...feeLines,
          ...(displayShipping != null && displayShipping !== 0 ? [{ label: 'Shipping Label', value: -displayShipping }] : []),
          ...(sale.discount ? [{ label: 'Discount', value: -sale.discount }] : []),
          ...(directCosts !== 0 ? [{ label: 'Paid directly (bank/card)', value: -directCosts }] : []),
        ]

        return (
          <div className="bg-gray-50 rounded-xl p-4">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Profitability</div>
            {profitLines.map(({ label, value }) => (
              <div key={label} className="flex justify-between py-0.5 text-xs">
                <span className={`${sale.fee_breakdown && label !== 'Revenue' && label !== 'COGS' ? 'text-gray-400 pl-2' : 'text-gray-600'}`}>{label}</span>
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
        )
      })()}

      <LinkedRecords kind="sale" id={sale.id} onNavigate={onNavigate} />
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [period, setPeriod] = useState<PeriodPreset>('ytd')
  const [search, setSearch] = useState('')
  const [platformFilter, setPlatformFilter] = useState<string | null>(null)
  const [returnFilter, setReturnFilter] = useState<'all' | 'none' | 'has_return'>('all')
  const [localSelected, setLocalSelected] = useState<Sale | null>(null)
  // ?sale=<id> deep link (lib/nav.ts) wins over a row click until closed.
  const [deepSaleId, clearDeepSale] = useDeepLink('sale')
  const setSelected = (s: Sale | null) => { clearDeepSale(); setLocalSelected(s) }
  const [showRecordSale, setShowRecordSale] = useState(false)
  const [linkSale, setLinkSale] = useState<Sale | null>(null)
  const [editSale, setEditSale] = useState<Sale | null>(null)
  const [returnSale, setReturnSale] = useState<Sale | null>(null)
  const [deleteSaleTarget, setDeleteSaleTarget] = useState<Sale | null>(null)
  const [openTradeId, setOpenTradeId] = useState<string | null>(null)
  const [openBundleId, setOpenBundleId] = useState<string | null>(null)
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

  const inList = deepSaleId ? sales.find(s => s.id === deepSaleId) ?? null : null
  const { data: deepSale } = useQuery({
    queryKey: ['sales', 'by-id', deepSaleId],
    enabled: !!deepSaleId && !inList,
    queryFn: () => fetchSaleById(deepSaleId!),
  })
  const selected = deepSaleId ? (inList ?? deepSale?.sale ?? null) : localSelected
  const detailNetPayouts = deepSaleId && !inList && deepSale ? deepSale.netPayoutBySale : netPayoutBySale

  const platformOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const s of sales) { if (s.platform) seen.add(s.platform) }
    return [...seen].sort()
  }, [sales])

  const filtered = useMemo(() => {
    return sales.filter(s => {
      if (platformFilter && s.platform !== platformFilter) return false
      // Sales without a return are stored as 'none' (never null); treat both as "no return".
      const hasReturn = s.return_status === 'full' || s.return_status === 'partial'
      if (returnFilter === 'none' && hasReturn) return false
      if (returnFilter === 'has_return' && !hasReturn) return false
      if (!search) return true
      const q = search.toLowerCase()
      return (
        (s.items?.name ?? '').toLowerCase().includes(q) ||
        (s.external_order_id ?? '').toLowerCase().includes(q) ||
        (s.platform ?? '').toLowerCase().includes(q) ||
        (s.payment_method ?? '').toLowerCase().includes(q) ||
        (paymentMethodLabel(s.payment_method) ?? '').toLowerCase().includes(q) ||
        formatPaymentSplits(s.payments).toLowerCase().includes(q)
      )
    })
  }, [sales, search, platformFilter, returnFilter])

  const totalRevenue = filtered
    .filter(s => s.return_status !== 'full')
    .reduce((sum, s) => {
      const refund = s.return_status === 'partial' ? (s.refunded_amount ?? 0) : 0
      return sum + s.sale_price - refund
    }, 0)

  const needsLink = filtered.filter(needsInventoryLink).length

  const [shortcutBannerOpen, setShortcutBannerOpen] = useState(true)
  const shortcutSales = useMemo(
    () => (sales ?? []).filter(s => !s.item_id && s.item_name),
    [sales]
  )

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-4 md:p-6 border-b border-gray-200 bg-white space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h1 className="text-lg font-semibold text-gray-900">Sales</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-gray-500">{formatUSD(totalRevenue)} revenue</span>
              {needsLink > 0 && (
                <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full text-xs font-medium">
                  {needsLink} need inventory link
                </span>
              )}
            </div>
          </div>
          <PeriodPicker value={period} onChange={p => { setPeriod(p); setPlatformFilter(null); setReturnFilter('all') }} />
          <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search item, order ID, platform, payment…"
              className="col-span-2 w-full md:w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <select
              value={platformFilter ?? ''}
              onChange={e => setPlatformFilter(e.target.value || null)}
              className="min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              <option value="">All platforms</option>
              {platformOptions.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <select
              value={returnFilter}
              onChange={e => setReturnFilter(e.target.value as 'all' | 'none' | 'has_return')}
              className="min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            >
              <option value="all">All returns</option>
              <option value="none">No returns</option>
              <option value="has_return">Has return</option>
            </select>
            <div className="hidden md:block md:flex-1" />
            <button
              onClick={() => setShowRecordSale(true)}
              className="col-span-2 flex items-center justify-center gap-1.5 bg-gray-900 text-white px-3 py-2 md:py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
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
            <>
            {shortcutSales.length > 0 && (
              <div className="m-3 md:m-0 md:mb-4 rounded-lg border border-amber-200 bg-amber-50">
                <button
                  onClick={() => setShortcutBannerOpen(o => !o)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-amber-800 text-left"
                >
                  <span className="min-w-0">⚠️ {shortcutSales.length} sale{shortcutSales.length > 1 ? 's' : ''} need attention — item not linked to inventory</span>
                  <span className="text-amber-600">{shortcutBannerOpen ? '▲' : '▼'}</span>
                </button>
                {shortcutBannerOpen && (
                  <ul className="border-t border-amber-200 divide-y divide-amber-100">
                    {shortcutSales.map(sale => (
                      <li key={sale.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm text-amber-900">
                        <button
                          className="flex-1 min-w-0 text-left hover:underline break-words"
                          onClick={() => setEditSale(sale)}
                        >
                          {sale.item_name} — {formatUSD(sale.sale_price)} — {formatDate(sale.sold_at)}
                        </button>
                        <button
                          onClick={() => setDeleteSaleTarget(sale)}
                          className="shrink-0 text-xs text-amber-600 hover:text-amber-800"
                        >
                          dismiss
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {/* Phones: one tappable card per sale */}
            <ul className="md:hidden divide-y divide-gray-100 bg-white">
              {filtered.map(sale => {
                const payout = netPayoutFor(sale, netPayoutBySale)
                const name = sale.items?.name ?? sale.item_name
                return (
                  <li
                    key={sale.id}
                    className={`px-4 py-3 active:bg-gray-50 ${selected?.id === sale.id ? 'bg-blue-50' : ''}`}
                    onClick={() => setSelected(sale)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-900 text-sm leading-snug line-clamp-2 break-words">
                          {!sale.items?.name && sale.item_name && '⚠️ '}
                          {name ?? <span className="text-gray-400">No item linked</span>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-gray-500">
                          <span className="tabular-nums">{sale.sold_at.slice(0, 10)}</span>
                          {sale.quantity !== 1 && <span>· Qty {sale.quantity}</span>}
                          {sale.trade_id ? (
                            <span
                              className="px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 rounded"
                              onClick={(e) => { e.stopPropagation(); setOpenTradeId(sale.trade_id!) }}
                            >
                              Trade
                            </span>
                          ) : (
                            <>
                              <PlatformBadge platform={sale.platform} />
                              {sale.bundle_id && (
                                <span
                                  className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 rounded"
                                  onClick={(e) => { e.stopPropagation(); setOpenBundleId(sale.bundle_id!) }}
                                >
                                  Bundle
                                </span>
                              )}
                            </>
                          )}
                          {/* "OK" on every card is noise on a small screen — only flag problems. */}
                          {sale.inventory_status !== 'ok' && <StatusBadge status={sale.inventory_status} type="inventory" />}
                          <StatusBadge status={sale.return_status} type="return" />
                          <ReviewBadge status={sale.review_status} compact />
                        </div>
                        {needsInventoryLink(sale) && (
                          <button
                            onClick={e => { e.stopPropagation(); setLinkSale(sale) }}
                            className="mt-1 flex items-center gap-1 text-amber-600 text-xs font-medium"
                          >
                            <Link2 size={12} /> Link to inventory
                          </button>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold tabular-nums text-gray-900">{formatUSD(sale.sale_price)}</div>
                        <div className={`text-xs tabular-nums ${payout < 0 ? 'text-red-500' : 'text-gray-500'}`}>
                          {formatUSD(payout)} net
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>

            <table className="hidden md:table w-full text-sm">
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
                          {needsInventoryLink(sale) && (
                            <button
                              onClick={e => { e.stopPropagation(); setLinkSale(sale) }}
                              className="flex items-center gap-1 text-amber-600 hover:text-amber-800 text-xs font-medium mt-0.5"
                            >
                              <Link2 size={12} /> Link to inventory lots
                            </button>
                          )}
                        </>
                      ) : sale.item_name ? (
                        <div>
                          <div className="font-medium text-gray-900 truncate max-w-xs">⚠️ {sale.item_name}</div>
                          <button
                            onClick={e => { e.stopPropagation(); setLinkSale(sale) }}
                            className="flex items-center gap-1 text-amber-600 hover:text-amber-800 text-xs font-medium mt-0.5"
                          >
                            <Link2 size={12} /> Link to inventory
                          </button>
                        </div>
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
                        <div className="flex items-center gap-1.5">
                          <PlatformBadge platform={sale.platform} />
                          {sale.bundle_id && (
                            <span
                              className="inline-block px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700 rounded cursor-pointer hover:bg-blue-200"
                              onClick={(e) => { e.stopPropagation(); setOpenBundleId(sale.bundle_id!) }}
                            >
                              Bundle
                            </span>
                          )}
                          {paymentMethodLabel(sale.payment_method) && (
                            <span className="text-[10px] text-gray-500" title={formatPaymentSplits(sale.payments) || undefined}>
                              {paymentMethodLabel(sale.payment_method)}
                            </span>
                          )}
                        </div>
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
                        <ReviewBadge status={sale.review_status} compact />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </>
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
            netPayoutBySale={detailNetPayouts}
            onLinkItem={() => setLinkSale(selected)}
            onEdit={() => setEditSale(selected)}
            onDelete={() => setDeleteSaleTarget(selected)}
            onProcessReturn={() => setReturnSale(selected)}
            onOpenTrade={(id) => { setSelected(null); setOpenTradeId(id) }}
            onOpenBundle={(id) => { setSelected(null); setOpenBundleId(id) }}
            onNavigate={() => setSelected(null)}
          />
        )}
      </SlideOver>

      <RecordSaleModal open={showRecordSale} onClose={() => setShowRecordSale(false)} />
      <BundleDetailSlideOver bundleId={openBundleId} onClose={() => setOpenBundleId(null)} />
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
