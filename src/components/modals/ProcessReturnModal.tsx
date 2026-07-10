import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { recordReturn } from '../../lib/mutations'
import type { Sale } from '../../lib/types'

interface Props {
  open: boolean
  onClose: () => void
  sale: Sale
}

export default function ProcessReturnModal({ open, onClose, sale }: Props) {
  const qc = useQueryClient()
  const remainingQty = sale.quantity - sale.refunded_quantity
  const [quantity, setQuantity] = useState(String(remainingQty))
  const [refundAmount, setRefundAmount] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => recordReturn({
      saleId: sale.id,
      quantity: parseInt(quantity, 10),
      refundAmount: parseFloat(refundAmount),
      reason: reason.trim() || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      reset()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function reset() {
    setQuantity(String(remainingQty))
    setRefundAmount('')
    setReason('')
    setError(null)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const q = parseInt(quantity, 10)
    const amt = parseFloat(refundAmount)
    if (!q || q <= 0 || q > remainingQty) {
      setError(`Quantity must be between 1 and ${remainingQty}`)
      return
    }
    if (isNaN(amt) || amt <= 0) {
      setError('Enter a valid refund amount')
      return
    }
    mutation.mutate()
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title="Process Return" width="max-w-md">
      <form onSubmit={submit}>
        <p className="text-xs text-gray-400 mb-3">
          Restores the returned quantity to its original inventory lot(s) and records a Returns &amp; Allowances transaction.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity" hint={`${remainingQty} available to return`}>
            <input
              type="number"
              min="1"
              max={remainingQty}
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
        <Field label="Reason" hint="Optional">
          <input value={reason} onChange={e => setReason(e.target.value)} className={inputCls} />
        </Field>

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
        <ModalActions onCancel={() => { reset(); onClose() }} submitLabel="Process Return" loading={mutation.isPending} />
      </form>
    </Modal>
  )
}
