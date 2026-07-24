import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { createLot, todayStr } from '../../lib/mutations'
import { formatUSD } from '../../lib/utils'

interface Props {
  open: boolean
  onClose: () => void
  itemId: string
  itemName: string
}

export default function AddLotModal({ open, onClose, itemId, itemName }: Props) {
  const qc = useQueryClient()
  const [quantity, setQuantity] = useState('1')
  const [unitCost, setUnitCost] = useState('')
  const [date, setDate] = useState(todayStr)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => createLot({
      itemId,
      quantity: parseInt(quantity, 10),
      unitCost: parseFloat(unitCost),
      purchaseDate: date || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      reset()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function reset() { setQuantity('1'); setUnitCost(''); setDate(todayStr()); setError(null) }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const q = parseInt(quantity, 10)
    const c = parseFloat(unitCost)
    if (!q || q <= 0) { setError('Quantity must be greater than 0'); return }
    if (isNaN(c) || c < 0) { setError('Enter a valid unit cost'); return }
    mutation.mutate()
  }

  const total = (parseInt(quantity, 10) || 0) * (parseFloat(unitCost) || 0)

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
          <Field label="Unit Cost">
            <input type="number" step="0.01" min="0" value={unitCost} onChange={e => setUnitCost(e.target.value)} className={inputCls} placeholder="0.00" />
          </Field>
        </div>
        {total > 0 && (
          <div className="text-xs text-gray-500 mb-3">
            Total lot cost: <span className="font-semibold text-gray-800">{formatUSD(total)}</span>
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
