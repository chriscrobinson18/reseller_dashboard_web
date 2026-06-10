import { useState, useMemo, Fragment } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { formatUSD, formatDate } from '../lib/utils'
import type { InventoryLot } from '../lib/types'
import { useItems, type ItemWithLots } from '../lib/queries'
import AddItemModal from '../components/modals/AddItemModal'
import AddLotModal from '../components/modals/AddLotModal'

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

function LotRows({ lots, onAddLot }: { lots: InventoryLot[]; onAddLot: () => void }) {
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
        <td className="pl-12 py-1.5 text-xs font-medium text-gray-500">Date Added</td>
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
        return (
          <tr key={lot.id} className="bg-blue-50/20 border-b border-blue-50">
            <td className="pl-12 py-2 text-xs text-gray-600">{formatDate(lot.created_at)}</td>
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
            <td className="px-3 py-2 text-xs tabular-nums text-gray-700 text-right">{formatUSD(lot.unit_cost)}</td>
            <td className="px-3 py-2 text-xs tabular-nums text-gray-900 font-medium text-right">
              {formatUSD(lot.quantity_remaining * lot.unit_cost)}
            </td>
            <td className="px-3 py-2">
              {lot.transaction_id ? (
                <span className="text-xs text-blue-600">Linked</span>
              ) : (
                <span className="text-xs text-gray-400 italic">No purchase record</span>
              )}
            </td>
            <td className="px-3 py-2">
              <div className="w-16 bg-gray-200 rounded-full h-1.5">
                <div
                  className="bg-gray-500 h-1.5 rounded-full"
                  style={{ width: `${pctSold}%` }}
                />
              </div>
              <div className="text-xs text-gray-400 mt-0.5">{pctSold.toFixed(0)}% sold</div>
            </td>
          </tr>
        )
      })}
      <AddLotRow onAddLot={onAddLot} />
    </>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const [search, setSearch] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showAddItem, setShowAddItem] = useState(false)
  const [addLotFor, setAddLotFor] = useState<ItemWithLots | null>(null)

  const { data: items = [], isLoading } = useItems()

  const filtered = useMemo(() => {
    if (!search) return items
    const q = search.toLowerCase()
    return items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.category ?? '').toLowerCase().includes(q)
    )
  }, [items, search])

  const totals = useMemo(() => {
    const allLots = items.flatMap(i => i.inventory_lots ?? [])
    const totalUnits = allLots.reduce((s, l) => s + l.quantity_remaining, 0)
    const totalValue = allLots.reduce((s, l) => s + l.quantity_remaining * l.unit_cost, 0)
    return { totalUnits, totalValue, itemCount: items.length }
  }, [items])

  function toggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
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
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search items…"
            className="w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          <button
            onClick={() => setShowAddItem(true)}
            className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
          >
            <Plus size={14} /> Add Item
          </button>
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
                      className={`data-row border-b border-gray-100 ${isExpanded ? 'bg-blue-50/30' : ''}`}
                      onClick={() => toggleExpand(item.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{item.name}</div>
                        {summary.unitsInStock === 0 && (
                          <span className="text-xs text-gray-400">Sold out</span>
                        )}
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
                    {isExpanded && <LotRows lots={lots} onAddLot={() => setAddLotFor(item)} />}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
        {filtered.length} items
      </div>

      <AddItemModal open={showAddItem} onClose={() => setShowAddItem(false)} />
      {addLotFor && (
        <AddLotModal
          open={!!addLotFor}
          onClose={() => setAddLotFor(null)}
          itemId={addLotFor.id}
          itemName={addLotFor.name}
        />
      )}
    </div>
  )
}
