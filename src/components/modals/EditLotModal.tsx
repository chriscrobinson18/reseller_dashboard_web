import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { updateLot } from '../../lib/mutations'
import { formatUSD } from '../../lib/utils'
import type { InventoryLot } from '../../lib/types'

interface Props {
  open: boolean
  onClose: () => void
  lot: InventoryLot
}

export default function EditLotModal({ open, onClose, lot }: Props) {
  const qc = useQueryClient()
  const [date, setDate] = useState(lot.purchase_date ?? lot.created_at.split('T')[0])
  const [unitCost, setUnitCost] = useState(String(lot.unit_cost))
  const [qtyPurchased, setQtyPurchased] = useState(String(lot.quantity_purchased))
  const [qtyRemaining, setQtyRemaining] = useState(String(lot.quantity_remaining))
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => updateLot(
      lot.id,
      parseFloat(unitCost),
      parseInt(qtyPurchased, 10),
      parseInt(qtyRemaining, 10),
      date || null,
    ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['items'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const c = parseFloat(unitCost)
    const qp = parseInt(qtyPurchased, 10)
    const qr = parseInt(qtyRemaining, 10)
    if (isNaN(c) || c < 0) { setError('Enter a valid unit cost'); return }
    if (!qp || qp <= 0) { setError('Quantity purchased must be greater than 0'); return }
    if (isNaN(qr) || qr < 0) { setError('Quantity remaining cannot be negative'); return }
    if (qr > qp) { setError('Remaining cannot exceed purchased'); return }
    mutation.mutate()
  }

  return (
    <Modal open={open} onClose={onClose} title="Edit Lot">
      <form onSubmit={submit}>
        <Field label="Purchase Date">
          <input autoFocus type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Unit Cost">
          <input type="number" step="0.01" min="0" value={unitCost} onChange={e => setUnitCost(e.target.value)} className={inputCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Qty Purchased">
            <input type="number" min="1" value={qtyPurchased} onChange={e => setQtyPurchased(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Qty Remaining" hint="Units still unsold">
            <input type="number" min="0" value={qtyRemaining} onChange={e => setQtyRemaining(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600 flex justify-between">
          <span>Remaining value at cost</span>
          <span className="font-semibold text-gray-900">
            {formatUSD((parseInt(qtyRemaining, 10) || 0) * (parseFloat(unitCost) || 0))}
          </span>
        </div>
        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
        <ModalActions onCancel={onClose} submitLabel="Save Changes" loading={mutation.isPending} />
      </form>
    </Modal>
  )
}
