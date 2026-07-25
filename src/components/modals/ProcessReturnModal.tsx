import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { fetchActiveReturn, recordReturn, reverseReturn, type ActiveReturn } from '../../lib/mutations'
import type { Sale } from '../../lib/types'

interface Props {
  open: boolean
  onClose: () => void
  sale: Sale
}

export default function ProcessReturnModal({ open, onClose, sale }: Props) {
  const isEditing = sale.return_status !== 'none'

  const { data: activeReturn, isLoading: loadingReturn } = useQuery({
    queryKey: ['activeReturn', sale.id],
    queryFn: () => fetchActiveReturn(sale.id),
    enabled: open && isEditing,
  })

  return (
    <Modal open={open} onClose={onClose} title={isEditing ? 'Edit Return' : 'Process Return'} width="max-w-md">
      {isEditing && loadingReturn ? (
        <div className="text-xs text-gray-400 py-4 text-center">Loading return…</div>
      ) : (
        <ReturnForm
          key={activeReturn?.id ?? 'new'}
          sale={sale}
          isEditing={isEditing}
          activeReturn={activeReturn ?? null}
          onClose={onClose}
        />
      )}
    </Modal>
  )
}

function ReturnForm({ sale, isEditing, activeReturn, onClose }: {
  sale: Sale
  isEditing: boolean
  activeReturn: ActiveReturn | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  // Editing replaces the existing return, so the full sale quantity is
  // eligible again; processing a new return is capped by what's left.
  const maxQty = isEditing ? sale.quantity : sale.quantity - sale.refunded_quantity

  const [quantity, setQuantity] = useState(String(activeReturn?.quantity ?? maxQty))
  const [refundAmount, setRefundAmount] = useState(activeReturn ? String(activeReturn.refundAmount) : '')
  const [returnShippingCost, setReturnShippingCost] = useState(
    activeReturn?.returnShippingCost ? String(activeReturn.returnShippingCost) : ''
  )
  const [reason, setReason] = useState(activeReturn?.reason ?? '')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      if (isEditing && activeReturn) {
        await reverseReturn(activeReturn.id)
      }
      return recordReturn({
        saleId: sale.id,
        quantity: parseInt(quantity, 10),
        refundAmount: parseFloat(refundAmount),
        returnShippingCost: returnShippingCost ? parseFloat(returnShippingCost) : null,
        reason: reason.trim() || null,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['activeReturn', sale.id] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const q = parseInt(quantity, 10)
    const amt = parseFloat(refundAmount)
    if (!q || q <= 0 || q > maxQty) {
      setError(`Quantity must be between 1 and ${maxQty}`)
      return
    }
    if (isNaN(amt) || amt <= 0) {
      setError('Enter a valid refund amount')
      return
    }
    mutation.mutate()
  }

  return (
    <form onSubmit={submit}>
      <p className="text-xs text-gray-400 mb-3">
        Restores the returned quantity to its original inventory lot(s) and records Returns &amp; Allowances / return-shipping transactions.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantity" hint={`${maxQty} available to return`}>
          <input
            type="number"
            min="1"
            max={maxQty}
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Refund Amount">
          <input
            type="number"
            step="0.01"
            min="0"
            value={refundAmount}
            onChange={e => setRefundAmount(e.target.value)}
            className={inputCls}
            placeholder="0.00"
          />
        </Field>
      </div>
      <Field label="Return Shipping Cost" hint="What you paid to ship the item back, if any">
        <input
          type="number"
          step="0.01"
          min="0"
          value={returnShippingCost}
          onChange={e => setReturnShippingCost(e.target.value)}
          className={inputCls}
          placeholder="0.00"
        />
      </Field>
      <Field label="Reason" hint="Optional">
        <input value={reason} onChange={e => setReason(e.target.value)} className={inputCls} />
      </Field>

      {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
      <ModalActions
        onCancel={onClose}
        submitLabel={isEditing ? 'Save Changes' : 'Process Return'}
        loading={mutation.isPending}
      />
    </form>
  )
}
