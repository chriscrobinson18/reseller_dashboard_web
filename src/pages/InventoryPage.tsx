import { useState, useMemo, Fragment } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, ChevronDown, ChevronRight, Plus, Pencil, Trash2, Receipt, PackageOpen } from 'lucide-react'
import { formatUSD, formatDate } from '../lib/utils'
import { deleteItem, deleteLot, deleteLotCostAdjustment } from '../lib/mutations'
import { basisFromAdjustments } from '../lib/lotCost'
import { adjustmentLabel } from '../lib/lotAdjustments'
import type { InventoryLot, LotCostAdjustment } from '../lib/types'
import { useItems, type ItemWithLots } from '../lib/queries'
import AddItemModal from '../components/modals/AddItemModal'
import RecordTradeModal from '../components/modals/RecordTradeModal'
import OpenBoxModal from '../components/modals/OpenBoxModal'
import AddLotModal from '../components/modals/AddLotModal'
import EditItemModal from '../components/modals/EditItemModal'
import EditLotModal from '../components/modals/EditLotModal'
import AddLotCostAdjustmentModal from '../components/modals/AddLotCostAdjustmentModal'
import ConfirmDialog from '../components/ConfirmDialog'
import TradeDetailSlideOver from '../components/TradeDetailSlideOver'
import BoxOpeningDetailSlideOver from '../components/BoxOpeningDetailSlideOver'
import LotTransactionSlideOver from '../components/LotTransactionSlideOver'

interface ItemSummary {
  unitsInStock: number
  totalValue: number
  avgCost: number
  totalPurchased: number
}

function getItemSummary(lots: InventoryLot[]): ItemSummary {
  const unitsInStock = lots.reduce((s, l) => s + l.quantity_remaining, 0)
  const totalValue = lots.reduce((s, l) => s + l.quantity_remaining * l.unit_cost, 0)
  const totalPurchased = lots.reduce((s, l) => s + l.quantity_purchased, 0)
  const avgCost = lots.length > 0
    ? lots.reduce((s, l) => s + l.unit_cost * l.quantity_purchased, 0) / Math.max(totalPurchased, 1)
    : 0
  return { unitsInStock, totalValue, avgCost, totalPurchased }
}

/** "Linked" / "2 sources" / "No purchase record" for a lot's Purchase Tx cell. */
function lotLinkLabel(lot: InventoryLot): string {
  const n = lot.inventory_lot_transactions?.length ?? (lot.transaction_id ? 1 : 0)
  if (n === 0) return 'No purchase record'
  return n === 1 ? 'Linked' : `${n} sources`
}

// ─── Lot rows ─────────────────────────────────────────────────────────────────

function AddLotRow({ onAddLot }: { onAddLot: () => void }) {
  return (
    <tr className="bg-blue-50/20 border-b border-blue-50">
      <td colSpan={7} className="pl-12 pr-4 py-2">
        <button
          onClick={e => { e.stopPropagation(); onAddLot() }}
          className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800"
        >
          <Plus size={13} /> Add purchase lot
        </button>
      </td>
    </tr>
  )
}

function LotRows({ lots, onAddLot, onEditLot, onDeleteLot, onTradePillClick, onBoxPillClick, onTxClick, onAddCost, onDeleteAdjustment, expandedBasis, onToggleBasis }: {
  lots: InventoryLot[]
  onAddLot: () => void
  onEditLot: (lot: InventoryLot) => void
  onDeleteLot: (lot: InventoryLot) => void
  onTradePillClick: (tradeId: string) => void
  onBoxPillClick: (boxOpeningId: string) => void
  onTxClick: (lot: InventoryLot) => void
  onAddCost: (lot: InventoryLot) => void
  onDeleteAdjustment: (adjustment: LotCostAdjustment) => void
  expandedBasis: Set<string>
  onToggleBasis: (lotId: string) => void
}) {
  if (lots.length === 0) {
    return (
      <>
        <tr>
          <td colSpan={7} className="pl-12 pr-4 py-2.5 text-xs text-gray-400 bg-blue-50/30 border-b border-blue-50">
            No inventory lots yet.
          </td>
        </tr>
        <AddLotRow onAddLot={onAddLot} />
      </>
    )
  }

  return (
    <>
      {/* Sub-header */}
      <tr className="bg-blue-50/40 border-b border-blue-100">
        <td className="pl-12 py-1.5 text-xs font-medium text-gray-500">Purchase Date</td>
        <td className="px-3 py-1.5 text-xs font-medium text-gray-500 text-center">Purchased</td>
        <td className="px-3 py-1.5 text-xs font-medium text-gray-500 text-center">Remaining</td>
        <td className="px-3 py-1.5 text-xs font-medium text-gray-500 text-right">Unit Cost</td>
        <td className="px-3 py-1.5 text-xs font-medium text-gray-500 text-right">Value</td>
        <td className="px-3 py-1.5 text-xs font-medium text-gray-500">Purchase Tx</td>
        <td />
      </tr>
      {lots.map(lot => {
        const pctSold = lot.quantity_purchased > 0
          ? ((lot.quantity_purchased - lot.quantity_remaining) / lot.quantity_purchased) * 100
          : 0
        // Also gated on having adjustments: removing the last one takes the
        // disclosure toggle away with it, which would strand an open breakdown.
        const basisOpen = expandedBasis.has(lot.id) && (lot.lot_cost_adjustments?.length ?? 0) > 0
        return (
          <Fragment key={lot.id}>
          <tr className="group bg-blue-50/20 border-b border-blue-50">
            <td className="pl-12 py-2 text-xs text-gray-600">{formatDate(lot.purchase_date ?? lot.created_at)}</td>
            <td className="px-3 py-2 text-xs text-gray-700 text-center">{lot.quantity_purchased}</td>
            <td className="px-3 py-2 text-center">
              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                lot.quantity_remaining === 0
                  ? 'bg-gray-100 text-gray-400'
                  : lot.quantity_remaining < lot.quantity_purchased
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-green-100 text-green-700'
              }`}>
                {lot.quantity_remaining}
              </span>
            </td>
            <UnitCostCell
              lot={lot}
              expanded={basisOpen}
              onToggle={() => onToggleBasis(lot.id)}
              className="px-3 py-2 text-xs tabular-nums text-gray-700 text-right"
            />
            <td className="px-3 py-2 text-xs tabular-nums text-gray-900 font-medium text-right">
              {formatUSD(lot.quantity_remaining * lot.unit_cost)}
            </td>
            <td className="px-3 py-2">
              <button
                onClick={e => { e.stopPropagation(); onTxClick(lot) }}
                className={`text-xs rounded px-1 -mx-1 hover:underline ${
                  lot.transaction_id ? 'text-blue-600' : 'text-gray-400 italic hover:text-blue-600'
                }`}
                title={lot.transaction_id ? 'View purchase transaction' : 'Find and link the purchase transaction'}
              >
                {lotLinkLabel(lot)}
              </button>
            </td>
            <td className="px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <div className="w-16 bg-gray-200 rounded-full h-1.5">
                    <div className="bg-gray-500 h-1.5 rounded-full" style={{ width: `${pctSold}%` }} />
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">{pctSold.toFixed(0)}% sold</div>
                </div>
                {lot.trade_id && (
                  <span
                    className="inline-block px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 rounded cursor-pointer hover:bg-purple-200"
                    onClick={(e) => { e.stopPropagation(); onTradePillClick(lot.trade_id!) }}
                    title="Acquired via trade"
                  >
                    Trade
                  </span>
                )}
                {lot.box_opening_id && (
                  <span
                    className="inline-block px-1.5 py-0.5 text-[10px] font-medium bg-teal-100 text-teal-700 rounded cursor-pointer hover:bg-teal-200"
                    onClick={(e) => { e.stopPropagation(); onBoxPillClick(lot.box_opening_id!) }}
                    title="From an opened box"
                  >
                    Box
                  </span>
                )}
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => onAddCost(lot)} className="p-1 text-gray-400 hover:text-blue-600" title="Add cost to basis (grading, shipping to grader)">
                    <Receipt size={12} />
                  </button>
                  <button onClick={() => onEditLot(lot)} className="p-1 text-gray-400 hover:text-gray-700" title="Edit lot">
                    <Pencil size={12} />
                  </button>
                  <button onClick={() => onDeleteLot(lot)} className="p-1 text-gray-400 hover:text-red-500" title="Delete lot">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </td>
          </tr>
          {basisOpen && (
            <BasisBreakdown
              lot={lot}
              colSpan={7}
              indentCls="pl-12"
              onDeleteAdjustment={onDeleteAdjustment}
            />
          )}
          </Fragment>
        )
      })}
      <AddLotRow onAddLot={onAddLot} />
    </>
  )
}


// ─── Cost basis breakdown ─────────────────────────────────────────────────────

/** A lot's basis and the adjustments behind it, when it has any. */
function lotBasisOf(lot: InventoryLot) {
  const adjustments = lot.lot_cost_adjustments ?? []
  const initialUnitCost = lot.initial_unit_cost ?? lot.unit_cost
  return {
    adjustments,
    initialUnitCost,
    ...basisFromAdjustments(
      initialUnitCost,
      lot.quantity_purchased,
      adjustments.map(a => Number(a.amount)),
    ),
  }
}

/**
 * Expanded ledger of what a lot's cost is made of — the purchase, then every
 * capitalized cost since (grading, shipping to the grader).
 *
 * Shows the lot *total*, not the per-unit figure: for a multi-unit lot the
 * rounded per-unit cost can't always express the true share, so the total is
 * the honest number (see basisFromAdjustments).
 */
function BasisBreakdown({ lot, colSpan, indentCls, onDeleteAdjustment }: {
  lot: InventoryLot
  colSpan: number
  indentCls: string
  onDeleteAdjustment: (adjustment: LotCostAdjustment) => void
}) {
  const { adjustments, initialUnitCost, totalBasis } = lotBasisOf(lot)
  const purchaseTotal = initialUnitCost * lot.quantity_purchased

  return (
    <tr className="bg-blue-50/10 border-b border-blue-50">
      <td colSpan={colSpan} className={`${indentCls} py-2 pr-4`}>
        <div className="text-xs text-gray-600 space-y-1">
          <div className="font-medium text-gray-700">
            Basis: <span className="tabular-nums">{formatUSD(totalBasis)}</span>
            {lot.quantity_purchased > 1 && (
              <span className="text-gray-400 font-normal">
                {' '}· {formatUSD(lot.unit_cost)}/unit
              </span>
            )}
          </div>
          <div className="flex gap-2 text-gray-500">
            <span className="tabular-nums w-20 text-right">{formatUSD(purchaseTotal)}</span>
            <span>Purchase · {formatDate(lot.purchase_date ?? lot.created_at)}</span>
          </div>
          {adjustments.map(a => (
            <div key={a.id} className="flex gap-2 text-gray-500 group/adj items-center">
              <span className="tabular-nums w-20 text-right">{formatUSD(Number(a.amount))}</span>
              <span>
                {adjustmentLabel(a.adjustment_type)} · {formatDate(a.incurred_on)}
                {a.grader && ` · ${a.grader}`}
                {a.grade_received && ` · ${a.grade_received}`}
                {!a.created_transaction && (
                  <span className="ml-1.5 text-[10px] text-gray-400 bg-gray-100 rounded px-1 py-0.5">
                    linked txn
                  </span>
                )}
              </span>
              <button
                onClick={() => onDeleteAdjustment(a)}
                className="p-0.5 text-gray-300 hover:text-red-500 opacity-0 group-hover/adj:opacity-100 transition-opacity"
                title="Remove this cost"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      </td>
    </tr>
  )
}

/** Unit cost with a disclosure toggle when the lot has capitalized costs. */
function UnitCostCell({ lot, expanded, onToggle, className }: {
  lot: InventoryLot
  expanded: boolean
  onToggle: () => void
  className: string
}) {
  const hasAdjustments = (lot.lot_cost_adjustments?.length ?? 0) > 0
  if (!hasAdjustments) {
    return <td className={className}>{formatUSD(lot.unit_cost)}</td>
  }
  return (
    <td className={className}>
      <button
        onClick={e => { e.stopPropagation(); onToggle() }}
        className="inline-flex items-center gap-0.5 hover:text-blue-600 rounded px-1 -mx-1"
        title={expanded ? 'Hide cost breakdown' : 'Show what this basis is made of'}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {formatUSD(lot.unit_cost)}
      </button>
    </td>
  )
}

// ─── Date view (lot ledger) ───────────────────────────────────────────────────

interface LedgerRow {
  lot: InventoryLot
  itemName: string
}

/** A lot's effective date — purchase_date when set, else the created_at fallback. */
function lotDate(lot: InventoryLot): string {
  return lot.purchase_date ?? lot.created_at
}

/**
 * Flat, newest-first ledger of every lot across all items. Complements the item
 * view: this is the shape you want when reconciling purchases against bank
 * transactions chronologically.
 */
function LotLedger({ rows, onEditLot, onDeleteLot, onTradePillClick, onBoxPillClick, onTxClick, onAddCost, onDeleteAdjustment, expandedBasis, onToggleBasis }: {
  rows: LedgerRow[]
  onEditLot: (lot: InventoryLot) => void
  onDeleteLot: (lot: InventoryLot) => void
  onTradePillClick: (tradeId: string) => void
  onBoxPillClick: (boxOpeningId: string) => void
  onTxClick: (lot: InventoryLot, itemName: string) => void
  onAddCost: (lot: InventoryLot) => void
  onDeleteAdjustment: (adjustment: LotCostAdjustment) => void
  expandedBasis: Set<string>
  onToggleBasis: (lotId: string) => void
}) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
        <tr>
          <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-32">Date</th>
          <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Item</th>
          <th className="text-center px-3 py-2.5 text-xs font-medium text-gray-500 w-24">Purchased</th>
          <th className="text-center px-3 py-2.5 text-xs font-medium text-gray-500 w-24">Remaining</th>
          <th className="text-right px-3 py-2.5 text-xs font-medium text-gray-500 w-24">Unit Cost</th>
          <th className="text-right px-3 py-2.5 text-xs font-medium text-gray-500 w-28">Lot Cost</th>
          <th className="text-left px-3 py-2.5 text-xs font-medium text-gray-500 w-36">Purchase Tx</th>
          <th className="w-16" />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ lot, itemName }) => (
          <Fragment key={lot.id}>
          <tr className="group border-b border-gray-100 hover:bg-gray-50/60">
            <td className="px-4 py-2.5 text-xs text-gray-600">{formatDate(lotDate(lot))}</td>
            <td className="px-4 py-2.5">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-gray-900 text-xs">{itemName}</span>
                {lot.trade_id && (
                  <button
                    onClick={() => onTradePillClick(lot.trade_id!)}
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 hover:bg-purple-200"
                  >
                    Trade
                  </button>
                )}
                {lot.box_opening_id && (
                  <button
                    onClick={() => onBoxPillClick(lot.box_opening_id!)}
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-teal-100 text-teal-700 hover:bg-teal-200"
                  >
                    Box
                  </button>
                )}
              </div>
            </td>
            <td className="px-3 py-2.5 text-xs text-gray-700 text-center">{lot.quantity_purchased}</td>
            <td className="px-3 py-2.5 text-center">
              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                lot.quantity_remaining === 0
                  ? 'bg-gray-100 text-gray-400'
                  : lot.quantity_remaining < lot.quantity_purchased
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-green-100 text-green-700'
              }`}>
                {lot.quantity_remaining}
              </span>
            </td>
            <UnitCostCell
              lot={lot}
              expanded={expandedBasis.has(lot.id)}
              onToggle={() => onToggleBasis(lot.id)}
              className="px-3 py-2.5 text-xs tabular-nums text-gray-700 text-right"
            />
            <td className="px-3 py-2.5 text-xs tabular-nums text-gray-900 font-medium text-right">
              {formatUSD(lot.quantity_purchased * lot.unit_cost)}
            </td>
            <td className="px-3 py-2.5">
              <button
                onClick={() => onTxClick(lot, itemName)}
                className={`text-xs rounded px-1 -mx-1 hover:underline ${
                  lot.transaction_id ? 'text-blue-600' : 'text-gray-400 italic hover:text-blue-600'
                }`}
                title={lot.transaction_id ? 'View purchase transaction' : 'Find and link the purchase transaction'}
              >
                {lotLinkLabel(lot)}
              </button>
            </td>
            <td className="px-3 py-2.5">
              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => onAddCost(lot)} className="p-1 text-gray-400 hover:text-blue-600" title="Add cost to basis (grading, shipping to grader)">
                  <Receipt size={12} />
                </button>
                <button onClick={() => onEditLot(lot)} className="p-1 text-gray-400 hover:text-gray-700" title="Edit lot">
                  <Pencil size={12} />
                </button>
                <button onClick={() => onDeleteLot(lot)} className="p-1 text-gray-400 hover:text-red-500" title="Delete lot">
                  <Trash2 size={12} />
                </button>
              </div>
            </td>
          </tr>
          {expandedBasis.has(lot.id) && (lot.lot_cost_adjustments?.length ?? 0) > 0 && (
            <BasisBreakdown
              lot={lot}
              colSpan={8}
              indentCls="pl-4"
              onDeleteAdjustment={onDeleteAdjustment}
            />
          )}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type InventoryView = 'item' | 'date'

export default function InventoryPage() {
  const [search, setSearch] = useState('')
  const [view, setView] = useState<InventoryView>('item')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showAddItem, setShowAddItem] = useState(false)
  const [addLotFor, setAddLotFor] = useState<ItemWithLots | null>(null)
  const [editItem, setEditItem] = useState<ItemWithLots | null>(null)
  const [deleteItemTarget, setDeleteItemTarget] = useState<ItemWithLots | null>(null)
  const [editLot, setEditLot] = useState<InventoryLot | null>(null)
  const [deleteLotTarget, setDeleteLotTarget] = useState<InventoryLot | null>(null)
  const [showRecordTrade, setShowRecordTrade] = useState(false)
  const [openTradeId, setOpenTradeId] = useState<string | null>(null)
  const [showOpenBox, setShowOpenBox] = useState(false)
  const [openBoxOpeningId, setOpenBoxOpeningId] = useState<string | null>(null)
  const [txLot, setTxLot] = useState<{ lot: InventoryLot; itemName: string } | null>(null)
  const [addCostFor, setAddCostFor] = useState<{ lot: InventoryLot; itemName: string } | null>(null)
  const [deleteAdjTarget, setDeleteAdjTarget] = useState<LotCostAdjustment | null>(null)
  const [expandedBasis, setExpandedBasis] = useState<Set<string>>(new Set())
  const qc = useQueryClient()

  const { data: items = [], isLoading } = useItems()

  function toggleBasis(lotId: string) {
    setExpandedBasis(prev => {
      const next = new Set(prev)
      if (next.has(lotId)) next.delete(lotId)
      else next.add(lotId)
      return next
    })
  }

  const delAdjMutation = useMutation({
    mutationFn: (id: string) => deleteLotCostAdjustment(id),
    onSuccess: () => {
      // Drops the lot's basis back down, and may remove a transaction.
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      setDeleteAdjTarget(null)
    },
  })

  const delItemMutation = useMutation({
    mutationFn: (id: string) => deleteItem(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['items'] }); setDeleteItemTarget(null) },
  })
  const delLotMutation = useMutation({
    mutationFn: (id: string) => deleteLot(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['items'] }); setDeleteLotTarget(null) },
  })

  const filtered = useMemo(() => {
    if (!search) return items
    const q = search.toLowerCase()
    return items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.category ?? '').toLowerCase().includes(q)
    )
  }, [items, search])

  /** Every lot across the (search-filtered) items, newest purchase first. */
  const ledgerRows = useMemo(() => {
    const rows: LedgerRow[] = filtered.flatMap(item =>
      (item.inventory_lots ?? []).map(lot => ({ lot, itemName: item.name }))
    )
    return rows.sort((a, b) => {
      const diff = lotDate(b.lot).localeCompare(lotDate(a.lot))
      return diff !== 0 ? diff : b.lot.created_at.localeCompare(a.lot.created_at)
    })
  }, [filtered])

  const totals = useMemo(() => {
    const allLots = items.flatMap(i => i.inventory_lots ?? [])
    const totalUnits = allLots.reduce((s, l) => s + l.quantity_remaining, 0)
    const totalValue = allLots.reduce((s, l) => s + l.quantity_remaining * l.unit_cost, 0)
    return { totalUnits, totalValue, itemCount: items.length }
  }, [items])

  function toggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 bg-white space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">Inventory</h1>
          <div className="flex items-center gap-4 text-sm text-gray-500">
            <span><strong className="text-gray-900">{totals.itemCount}</strong> items</span>
            <span><strong className="text-gray-900">{totals.totalUnits}</strong> units in stock</span>
            <span className="font-semibold text-gray-900">{formatUSD(totals.totalValue)} value</span>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search items…"
              className="w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
              {([['item', 'By Item'], ['date', 'By Date']] as const).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    view === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowRecordTrade(true)}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
            >
              <ArrowLeftRight size={14} /> Record Trade
            </button>
            <button
              onClick={() => setShowOpenBox(true)}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
            >
              <PackageOpen size={14} /> Open Box
            </button>
            <button
              onClick={() => setShowAddItem(true)}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
            >
              <Plus size={14} /> Add Item
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading inventory…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            {search ? 'No items found.' : 'No inventory items yet. Click "Add Item" to start.'}
          </div>
        ) : view === 'date' ? (
          ledgerRows.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              {search ? 'No lots on the matching items.' : 'No purchase lots yet. Add one from an item in the By Item view.'}
            </div>
          ) : (
            <LotLedger
              rows={ledgerRows}
              onEditLot={setEditLot}
              onDeleteLot={setDeleteLotTarget}
              onTradePillClick={setOpenTradeId}
              onBoxPillClick={setOpenBoxOpeningId}
              onTxClick={(lot, itemName) => setTxLot({ lot, itemName })}
              onAddCost={lot => setAddCostFor({
                lot,
                itemName: ledgerRows.find(r => r.lot.id === lot.id)?.itemName ?? '',
              })}
              onDeleteAdjustment={setDeleteAdjTarget}
              expandedBasis={expandedBasis}
              onToggleBasis={toggleBasis}
            />
          )
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Item</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-28">Category</th>
                <th className="text-center px-4 py-2.5 text-xs font-medium text-gray-500 w-24">In Stock</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500 w-28">Value at Cost</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500 w-28">Avg Cost</th>
                <th className="text-center px-4 py-2.5 text-xs font-medium text-gray-500 w-16">Lots</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => {
                const lots = item.inventory_lots ?? []
                const summary = getItemSummary(lots)
                const isExpanded = expandedIds.has(item.id)

                return (
                  <Fragment key={item.id}>
                    <tr
                      className={`group data-row border-b border-gray-100 ${isExpanded ? 'bg-blue-50/30' : ''}`}
                      onClick={() => toggleExpand(item.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div>
                            <div className="font-medium text-gray-900">{item.name}</div>
                            {summary.unitsInStock === 0 && (
                              <span className="text-xs text-gray-400">Sold out</span>
                            )}
                          </div>
                          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                            <button onClick={() => setEditItem(item)} className="p-1 text-gray-400 hover:text-gray-700" title="Edit item">
                              <Pencil size={12} />
                            </button>
                            <button onClick={() => setDeleteItemTarget(item)} className="p-1 text-gray-400 hover:text-red-500" title="Delete item">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{item.category || '—'}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-sm font-semibold ${
                          summary.unitsInStock === 0 ? 'text-gray-400' : 'text-gray-900'
                        }`}>
                          {summary.unitsInStock}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">
                        {formatUSD(summary.totalValue)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-600 text-xs">
                        {lots.length > 0 ? formatUSD(summary.avgCost) : '—'}
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-gray-500">
                        {lots.length}
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {isExpanded
                          ? <ChevronDown size={14} />
                          : <ChevronRight size={14} />
                        }
                      </td>
                    </tr>
                    {isExpanded && (
                      <LotRows
                        lots={lots}
                        onAddLot={() => setAddLotFor(item)}
                        onEditLot={setEditLot}
                        onDeleteLot={setDeleteLotTarget}
                        onTradePillClick={setOpenTradeId}
                        onBoxPillClick={setOpenBoxOpeningId}
                        onTxClick={lot => setTxLot({ lot, itemName: item.name })}
                        onAddCost={lot => setAddCostFor({ lot, itemName: item.name })}
                        onDeleteAdjustment={setDeleteAdjTarget}
                        expandedBasis={expandedBasis}
                        onToggleBasis={toggleBasis}
                      />
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
        {view === 'date'
          ? `${ledgerRows.length} ${ledgerRows.length === 1 ? 'lot' : 'lots'}`
          : `${filtered.length} items`}
      </div>

      <RecordTradeModal open={showRecordTrade} onClose={() => setShowRecordTrade(false)} />
      <TradeDetailSlideOver tradeId={openTradeId} onClose={() => setOpenTradeId(null)} />
      <OpenBoxModal open={showOpenBox} onClose={() => setShowOpenBox(false)} />
      <BoxOpeningDetailSlideOver boxOpeningId={openBoxOpeningId} onClose={() => setOpenBoxOpeningId(null)} />
      <LotTransactionSlideOver
        lot={txLot?.lot ?? null}
        itemName={txLot?.itemName}
        onClose={() => setTxLot(null)}
      />
      <AddItemModal open={showAddItem} onClose={() => setShowAddItem(false)} />
      {addLotFor && (
        <AddLotModal
          open={!!addLotFor}
          onClose={() => setAddLotFor(null)}
          itemId={addLotFor.id}
          itemName={addLotFor.name}
        />
      )}
      {editItem && (
        <EditItemModal open={!!editItem} onClose={() => setEditItem(null)} item={editItem} />
      )}
      {editLot && (
        <EditLotModal open={!!editLot} onClose={() => setEditLot(null)} lot={editLot} />
      )}
      {addCostFor && (
        <AddLotCostAdjustmentModal
          open={!!addCostFor}
          onClose={() => setAddCostFor(null)}
          lot={addCostFor.lot}
          itemName={addCostFor.itemName}
        />
      )}
      <ConfirmDialog
        open={!!deleteItemTarget}
        title="Delete item?"
        message={`"${deleteItemTarget?.name}" and its inventory lots will be removed (soft delete). Past sales referencing it are kept.`}
        loading={delItemMutation.isPending}
        onConfirm={() => deleteItemTarget && delItemMutation.mutate(deleteItemTarget.id)}
        onCancel={() => setDeleteItemTarget(null)}
      />
      <ConfirmDialog
        open={!!deleteLotTarget}
        title="Delete lot?"
        message="This purchase lot will be removed (soft delete). Inventory counts and value will update."
        loading={delLotMutation.isPending}
        onConfirm={() => deleteLotTarget && delLotMutation.mutate(deleteLotTarget.id)}
        onCancel={() => setDeleteLotTarget(null)}
      />
      <ConfirmDialog
        open={!!deleteAdjTarget}
        title="Remove this cost?"
        message={
          deleteAdjTarget?.created_transaction
            ? "The lot's basis drops back down and the Cost of Goods transaction this created is deleted."
            : "The lot's basis drops back down. The linked transaction is kept — it's a real payment that exists on its own."
        }
        loading={delAdjMutation.isPending}
        onConfirm={() => deleteAdjTarget && delAdjMutation.mutate(deleteAdjTarget.id)}
        onCancel={() => setDeleteAdjTarget(null)}
      />
    </div>
  )
}
