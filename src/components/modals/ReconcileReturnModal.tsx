import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { recordReturn } from '../../lib/mutations'
import { formatUSD, formatDate } from '../../lib/utils'
import type { CSVReturnCandidate } from '../../lib/csvReturns'

interface Props {
  open: boolean
  onClose: () => void
  candidate: CSVReturnCandidate
  platform: 'ebay' | 'amazon'
}

/**
 * Reviews one detected CSV return candidate and applies it via the same
 * `recordReturn` primitive the manual ProcessReturnModal uses — passing the
 * matched transaction ids so record_return re-tags them instead of inserting
 * duplicates. See docs/features/settings.md#return-reconciliation.
 */
export default function ReconcileReturnModal({ open, onClose, candidate, platform }: Props) {
  const qc = useQueryClient()
  const { refundTransaction, shippingCandidate, candidateSales } = candidate

  const [saleId, setSaleId] = useState(candidateSales[0]?.id ?? '')
  const selectedSale = candidateSales.find(s => s.id === saleId) ?? null
  const maxQty = selectedSale ? selectedSale.quantity - selectedSale.refunded_quantity : 0

  const [quantity, setQuantity] = useState(String(maxQty || 1))
  const [refundAmount, setRefundAmount] = useState(String(Math.abs(refundTransaction.amount)))
  const [includeShipping, setIncludeShipping] = useState(!!shippingCandidate)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => {
      if (!selectedSale) throw new Error('Select a sale to apply this return to')
      return recordReturn({
        saleId: selectedSale.id,
        quantity: parseInt(quantity, 10),
        refundAmount: parseFloat(refundAmount),
        returnShippingCost: includeShipping && shippingCandidate ? Math.abs(shippingCandidate.amount) : undefined,
        refundTransactionId: refundTransaction.id,
        returnShippingTransactionId: includeShipping && shippingCandidate ? shippingCandidate.id : undefined,
        reason: reason.trim() || null,
        source: 'csv_import',
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['csv-return-candidates', platform] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!selectedSale) { setError('Select a sale to apply this return to'); return }
    const q = parseInt(quantity, 10)
    const amt = parseFloat(refundAmount)
    if (!q || q <= 0 || q > maxQty) { setError(`Quantity must be between 1 and ${maxQty}`); return }
    if (isNaN(amt) || amt <= 0) { setError('Enter a valid refund amount'); return }
    mutation.mutate()
  }

  return (
    <Modal open={open} onClose={onClose} title="Reconcile Return" width="max-w-md">
      <div className="bg-gray-50 rounded-lg p-3 mb-3 text-xs space-y-1">
        <div className="flex justify-between">
          <span className="text-gray-400">Order</span>
          <span className="text-gray-800 font-medium">{candidate.orderRef}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Refund row</span>
          <span className="text-gray-800 font-medium">
            {formatDate(refundTransaction.date)} · {formatUSD(Math.abs(refundTransaction.amount))}
          </span>
        </div>
        {shippingCandidate && (
          <div className="flex justify-between">
            <span className="text-gray-400">Return shipping (best guess)</span>
            <span className="text-gray-800 font-medium">
              {formatDate(shippingCandidate.date)} · {formatUSD(Math.abs(shippingCandidate.amount))}
            </span>
          </div>
        )}
      </div>

      {candidateSales.length === 0 ? (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          No inventory-linked sale found for this order — nothing to apply this return to. Leave it be, or
          re-tag the refund row's category manually in Expenses if it isn't actually a return.
        </div>
      ) : (
        <form onSubmit={submit}>
          {candidateSales.length > 1 && (
            <Field label="Sale">
              <select value={saleId} onChange={e => setSaleId(e.target.value)} className={inputCls}>
                {candidateSales.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.item_name ?? s.items?.name ?? 'Item'} · {s.quantity} unit{s.quantity > 1 ? 's' : ''} · {formatUSD(s.sale_price)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {selectedSale && candidateSales.length === 1 && (
            <div className="mb-3 text-xs text-gray-500">
              Matched to <span className="text-gray-800 font-medium">{selectedSale.item_name ?? selectedSale.items?.name ?? 'Item'}</span> ({selectedSale.quantity} unit{selectedSale.quantity > 1 ? 's' : ''}, {formatUSD(selectedSale.sale_price)})
            </div>
          )}
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
              />
            </Field>
          </div>
          {shippingCandidate && (
            <label className="flex items-center gap-2 text-xs text-gray-600 mt-3">
              <input type="checkbox" checked={includeShipping} onChange={e => setIncludeShipping(e.target.checked)} />
              Include the {formatUSD(Math.abs(shippingCandidate.amount))} return-shipping row above
            </label>
          )}
          <Field label="Reason" hint="Optional">
            <input value={reason} onChange={e => setReason(e.target.value)} className={inputCls} />
          </Field>

          {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
          <ModalActions
            onCancel={onClose}
            submitLabel="Apply Return"
            loading={mutation.isPending}
          />
        </form>
      )}
    </Modal>
  )
}
