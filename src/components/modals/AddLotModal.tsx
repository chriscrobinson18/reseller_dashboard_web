import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { createLotsForPurchase, todayStr } from '../../lib/mutations'
import { splitLotCost } from '../../lib/lotCost'
import { formatUSD } from '../../lib/utils'

interface Props {
  open: boolean
  onClose: () => void
  itemId: string
  itemName: string
}

type CostMode = 'total' | 'unit'

export default function AddLotModal({ open, onClose, itemId, itemName }: Props) {
  const qc = useQueryClient()
  const [quantity, setQuantity] = useState('1')
  const [mode, setMode] = useState<CostMode>('total')
  const [cost, setCost] = useState('')
  const [date, setDate] = useState(todayStr)
  const [error, setError] = useState<string | null>(null)

  const qty = parseInt(quantity, 10)
  const costNum = parseFloat(cost)
  const validQty = !!qty && qty > 0
  const validCost = !isNaN(costNum) && costNum >= 0

  // In unit mode the user's figure is per-unit, so scale it up to a lot total;
  // the split then hands back exactly that total.
  const totalCost = validQty && validCost ? (mode === 'total' ? costNum : costNum * qty) : 0
  const tiers = validQty && validCost ? splitLotCost(totalCost, qty) : []
  const isSplit = tiers.length > 1

  const mutation = useMutation({
    mutationFn: () => createLotsForPurchase({
      itemId,
      quantity: qty,
      totalCost,
      purchaseDate: date || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      reset()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function reset() {
    setQuantity('1'); setMode('total'); setCost(''); setDate(todayStr()); setError(null)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!validQty) { setError('Quantity must be greater than 0'); return }
    if (!validCost) { setError(`Enter a valid ${mode === 'total' ? 'total' : 'unit'} cost`); return }
    mutation.mutate()
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title={`Add Purchase Lot — ${itemName}`}>
      <form onSubmit={submit}>
        <Field label="Purchase Date">
          <input autoFocus type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity Purchased">
            <input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)} className={inputCls} />
          </Field>
          <Field label={mode === 'total' ? 'Total Cost' : 'Unit Cost'}>
            <input
              type="number" step="0.01" min="0" value={cost}
              onChange={e => setCost(e.target.value)}
              className={inputCls} placeholder="0.00"
            />
          </Field>
        </div>

        {/* Cost entry mode */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5 mb-3">
          {(['total', 'unit'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              {m === 'total' ? 'Enter total paid' : 'Enter cost per unit'}
            </button>
          ))}
        </div>

        {/* Split preview */}
        {tiers.length > 0 && (
          <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs mb-3 space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-600">Total lot cost</span>
              <span className="font-semibold text-gray-900">{formatUSD(totalCost)}</span>
            </div>
            {isSplit ? (
              <div className="text-gray-500 border-t border-gray-200 pt-1">
                {formatUSD(totalCost)} doesn't divide evenly across {qty} units, so this creates{' '}
                <strong className="text-gray-700">2 lots</strong> that add up exactly:
                <div className="mt-1 space-y-0.5">
                  {tiers.map((t, i) => (
                    <div key={i} className="flex justify-between text-gray-600">
                      <span>{t.quantity} × {formatUSD(t.unitCost)}</span>
                      <span className="tabular-nums">{formatUSD(t.quantity * t.unitCost)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex justify-between text-gray-500">
                <span>{tiers[0].quantity} × {formatUSD(tiers[0].unitCost)} per unit</span>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-gray-400 mb-1">
          This creates an orphaned lot (no linked purchase transaction). You can link it to a Cost of Goods transaction later from the Expenses tab.
        </p>
        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
        <ModalActions onCancel={() => { reset(); onClose() }} submitLabel="Add Lot" loading={mutation.isPending} />
      </form>
    </Modal>
  )
}
