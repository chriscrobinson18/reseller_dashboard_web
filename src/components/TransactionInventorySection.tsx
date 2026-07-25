import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Package } from 'lucide-react'
import { createItem, createLotsForPurchase, deleteLot, fetchLotsForTransaction } from '../lib/mutations'
import ItemPicker from './ItemPicker'
import { inputCls } from './Modal'
import { splitLotCost } from '../lib/lotCost'
import { formatUSD } from '../lib/utils'
import type { ItemWithLots } from '../lib/queries'

interface Props {
  transactionId: string
  /** Absolute value of the transaction amount, for the allocated-vs-total summary. */
  transactionTotal: number
}

/**
 * Shown in the transaction detail panel for Cost of Goods transactions.
 * Lets the user turn a purchase expense into inventory by creating lots linked
 * to this transaction (transaction_id FK). Mirrors iOS AddInventoryLotSheet.
 */
export default function TransactionInventorySection({ transactionId, transactionTotal }: Props) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [item, setItem] = useState<ItemWithLots | null>(null)
  const [newItemName, setNewItemName] = useState('')
  const [newItemCategory, setNewItemCategory] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [totalCost, setTotalCost] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: lots = [], isLoading } = useQuery({
    queryKey: ['lots-for-tx', transactionId],
    queryFn: () => fetchLotsForTransaction(transactionId),
  })

  const addMutation = useMutation({
    mutationFn: async () => {
      let itemId: string
      let itemName: string
      if (mode === 'new') {
        const created = await createItem(newItemName.trim(), newItemCategory.trim() || null)
        itemId = created.id
        itemName = created.name
        qc.invalidateQueries({ queryKey: ['items'] })
      } else {
        if (!item) throw new Error('Select an item')
        itemId = item.id
        itemName = item.name
      }
      await createLotsForPurchase({
        itemId,
        quantity: parseInt(quantity, 10),
        totalCost: parseFloat(totalCost),
        transactionId,
      })
      return itemName
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lots-for-tx', transactionId] })
      qc.invalidateQueries({ queryKey: ['items'] })
      resetForm()
    },
    onError: (e: Error) => setError(e.message),
  })

  const removeMutation = useMutation({
    mutationFn: (lotId: string) => deleteLot(lotId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lots-for-tx', transactionId] })
      qc.invalidateQueries({ queryKey: ['items'] })
    },
  })

  function resetForm() {
    setAdding(false); setMode('existing'); setItem(null)
    setNewItemName(''); setNewItemCategory(''); setQuantity('1'); setTotalCost(''); setError(null)
  }

  function submitAdd() {
    setError(null)
    const q = parseInt(quantity, 10)
    const c = parseFloat(totalCost)
    if (mode === 'new' && !newItemName.trim()) { setError('Enter an item name'); return }
    if (mode === 'existing' && !item) { setError('Select an item'); return }
    if (!q || q <= 0) { setError('Quantity must be greater than 0'); return }
    if (isNaN(c) || c < 0) { setError('Enter a valid total cost'); return }
    addMutation.mutate()
  }

  // Per-link amount, not the lot's full cost: a split-tender lot is only
  // partly funded by this transaction, and summing full cost would overstate
  // how much of this purchase has been turned into inventory.
  const allocated = lots.reduce((s, l) => s + Number(l.allocated_amount), 0)
  const remaining = transactionTotal - allocated

  const pendingQty = parseInt(quantity, 10)
  const pendingTotal = parseFloat(totalCost)
  const pendingTiers = pendingQty > 0 && !isNaN(pendingTotal) && pendingTotal >= 0
    ? splitLotCost(pendingTotal, pendingQty)
    : []

  return (
    <div className="border-t border-gray-100 pt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Inventory Lots</div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
          >
            <Plus size={12} /> Add lot
          </button>
        )}
      </div>

      {/* Existing linked lots */}
      {isLoading ? (
        <div className="text-xs text-gray-400">Loading…</div>
      ) : lots.length === 0 && !adding ? (
        <div className="text-xs text-gray-400 bg-gray-50 rounded-lg p-3">
          No inventory linked to this purchase yet. Add a lot to turn this expense into trackable inventory.
        </div>
      ) : (
        <div className="space-y-1.5">
          {lots.map(lot => (
            <div key={lot.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
              <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center shrink-0">
                <Package size={12} className="text-gray-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-900 truncate">{lot.items?.name ?? 'Item'}</div>
                <div className="text-xs text-gray-400">
                  {lot.quantity_purchased} × {formatUSD(lot.unit_cost)} · {lot.quantity_remaining} left
                </div>
              </div>
              <div className="text-xs font-medium tabular-nums text-gray-700 text-right">
                {formatUSD(Number(lot.allocated_amount))}
                {Math.abs(Number(lot.allocated_amount) - lot.quantity_purchased * lot.unit_cost) >= 0.01 && (
                  <div className="text-[10px] font-normal text-gray-400">
                    of {formatUSD(lot.quantity_purchased * lot.unit_cost)} lot
                  </div>
                )}
              </div>
              <button
                onClick={() => removeMutation.mutate(lot.id)}
                className="text-gray-300 hover:text-red-500 p-1"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Allocated vs total summary */}
      {lots.length > 0 && (
        <div className="flex justify-between text-xs mt-2 px-1">
          <span className="text-gray-400">Allocated of {formatUSD(transactionTotal)}</span>
          <span className={`font-medium ${Math.abs(allocated - transactionTotal) < 0.01 ? 'text-green-600' : 'text-gray-700'}`}>
            {formatUSD(allocated)}
          </span>
        </div>
      )}

      {/* Add lot form */}
      {adding && (
        <div className="mt-3 border border-gray-200 rounded-xl p-3 space-y-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            {(['existing', 'new'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
                  mode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}
              >
                {m === 'existing' ? 'Existing Item' : 'New Item'}
              </button>
            ))}
          </div>

          {mode === 'existing' ? (
            <ItemPicker selectedId={item?.id ?? null} onSelect={setItem} />
          ) : (
            <div className="space-y-2">
              <input value={newItemName} onChange={e => setNewItemName(e.target.value)} className={inputCls} placeholder="Item name" />
              <input value={newItemCategory} onChange={e => setNewItemCategory(e.target.value)} className={inputCls} placeholder="Category (optional)" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Quantity</label>
              <input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)} className={inputCls} />
            </div>
            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label className="block text-xs text-gray-500">Total Cost</label>
                {remaining > 0.005 && (
                  <button
                    type="button"
                    onClick={() => setTotalCost(remaining.toFixed(2))}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    Use {formatUSD(remaining)}
                  </button>
                )}
              </div>
              <input type="number" step="0.01" min="0" value={totalCost} onChange={e => setTotalCost(e.target.value)} className={inputCls} placeholder="0.00" />
            </div>
          </div>

          {pendingTiers.length > 1 && (
            <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-2.5 py-2">
              Splits into {pendingTiers.map(t => `${t.quantity} × ${formatUSD(t.unitCost)}`).join(' + ')} so
              the lots total exactly {formatUSD(pendingTotal)}.
            </div>
          )}

          {error && <div className="text-xs text-red-600">{error}</div>}

          <div className="flex gap-2 justify-end">
            <button onClick={resetForm} className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg">
              Cancel
            </button>
            <button
              onClick={submitAdd}
              disabled={addMutation.isPending}
              className="px-3 py-1.5 text-xs font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
            >
              {addMutation.isPending ? 'Adding…' : 'Add Lot'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
