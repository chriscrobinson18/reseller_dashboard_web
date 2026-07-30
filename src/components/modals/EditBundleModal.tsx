import { useState, useMemo, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { updateBundleSale } from '../../lib/mutations'
import { useBundle } from '../../lib/queries'
import { formatUSD } from '../../lib/utils'
import { PAYMENT_METHODS } from '../../lib/paymentMethods'

const PLATFORMS = ['ebay', 'amazon', 'tcgplayer', 'mercari', 'stockx', 'goat', 'whatnot', 'manual']

interface LineState {
  id: string
  itemName: string
  quantity: string
  salePrice: string
}

const safeNum = (v: string): number => {
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

/**
 * Order-level fields + every line's price/quantity. Line *item* is not
 * editable — see updateBundleSale's docblock for why.
 */
export default function EditBundleModal({ bundleId, onClose }: { bundleId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { data, isLoading } = useBundle(bundleId)

  return (
    <Modal open={!!bundleId} onClose={onClose} title="Edit Bundle Sale" width="max-w-2xl">
      {isLoading || !data ? (
        <div className="text-xs text-gray-400 py-4">Loading…</div>
      ) : (
        <EditBundleForm bundleId={bundleId} data={data} onClose={onClose} qc={qc} />
      )}
    </Modal>
  )
}

function EditBundleForm({ bundleId, data, onClose, qc }: {
  bundleId: string
  data: NonNullable<ReturnType<typeof useBundle>['data']>
  onClose: () => void
  qc: ReturnType<typeof useQueryClient>
}) {
  const { bundle, lines } = data
  const [soldAt, setSoldAt] = useState(bundle.sold_at.slice(0, 10))
  const [platform, setPlatform] = useState(bundle.platform ?? 'ebay')
  const [paymentMethod, setPaymentMethod] = useState(bundle.payment_method ?? '')
  const [orderId, setOrderId] = useState(bundle.external_order_id ?? '')
  const [fees, setFees] = useState(bundle.fees ? String(bundle.fees) : '')
  const [shipping, setShipping] = useState(bundle.shipping_cost != null ? String(bundle.shipping_cost) : '')
  const [notes, setNotes] = useState(bundle.notes ?? '')
  const [lineStates, setLineStates] = useState<LineState[]>(() => lines.map(l => ({
    id: l.id,
    itemName: l.items?.name ?? '—',
    quantity: String(l.quantity),
    salePrice: String(l.sale_price),
  })))
  const [error, setError] = useState<string | null>(null)

  const total = useMemo(() => lineStates.reduce((s, l) => s + safeNum(l.salePrice), 0), [lineStates])
  const netPayout = total - safeNum(fees) - safeNum(shipping)

  const validationError = useMemo(() => {
    for (const l of lineStates) {
      if (!l.quantity || safeNum(l.quantity) <= 0) return 'Every line needs a quantity greater than 0'
      if (safeNum(l.salePrice) < 0) return 'Enter a valid sale price for every line'
    }
    if (total <= 0) return 'Enter at least one sale price'
    return null
  }, [lineStates, total])

  const mutation = useMutation({
    mutationFn: () => updateBundleSale({
      bundleId,
      soldAt,
      platform,
      paymentMethod: paymentMethod || null,
      externalOrderId: orderId.trim() || null,
      fees: fees ? parseFloat(fees) : null,
      shippingCost: shipping ? parseFloat(shipping) : null,
      notes: notes.trim() || null,
      lines: lineStates.map(l => ({ id: l.id, quantity: safeNum(l.quantity), salePrice: safeNum(l.salePrice) })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['bundle'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function updateLine(i: number, patch: Partial<LineState>) {
    setLineStates(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (validationError) return
    mutation.mutate()
  }

  return (
    <form onSubmit={submit}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Items ({lineStates.length})</h3>
        <span className="text-xs text-gray-500 tabular-nums">Total: {formatUSD(total)}</span>
      </div>

      <div className="space-y-2 mb-3">
        {lineStates.map((l, i) => (
          <div key={l.id} className="border border-gray-200 rounded-lg p-3">
            <div className="grid grid-cols-[1fr_70px_100px] gap-2 items-start">
              <div className={`${inputCls} bg-gray-50 text-gray-700 flex items-center`}>{l.itemName}</div>
              <input
                type="number" min="1" step="1" value={l.quantity} title="Quantity"
                onChange={e => updateLine(i, { quantity: e.target.value })}
                className={inputCls}
              />
              <input
                type="number" min="0" step="0.01" value={l.salePrice} title="Sale price"
                onChange={e => updateLine(i, { salePrice: e.target.value })}
                className={inputCls} placeholder="Price"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Platform">
          <select value={platform} onChange={e => setPlatform(e.target.value)} className={inputCls + ' capitalize bg-white'}>
            {PLATFORMS.map(p => <option key={p} value={p} className="capitalize">{p}</option>)}
          </select>
        </Field>
        <Field label="Payment Method" hint={platform === 'manual' ? 'How you were paid' : 'Optional'}>
          <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className={inputCls + ' bg-white'}>
            <option value="">—</option>
            {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Sale Date">
          <input type="date" value={soldAt} onChange={e => setSoldAt(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Order ID" hint="Optional">
          <input value={orderId} onChange={e => setOrderId(e.target.value)} className={inputCls} placeholder="e.g. 01-12345-67890" />
        </Field>
        <Field label="Order Fees" hint="Applies once, to the whole order">
          <input type="number" step="0.01" min="0" value={fees} onChange={e => setFees(e.target.value)} className={inputCls} placeholder="0.00" />
        </Field>
        <Field label="Shipping Cost" hint="Applies once, to the whole order">
          <input type="number" step="0.01" min="0" value={shipping} onChange={e => setShipping(e.target.value)} className={inputCls} placeholder="0.00" />
        </Field>
      </div>

      <Field label="Notes" hint="Optional">
        <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
      </Field>

      <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600 flex justify-between">
        <span>Net payout after fees &amp; shipping</span>
        <span className="font-semibold text-gray-900">{formatUSD(netPayout)}</span>
      </div>

      {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
      {validationError && !error && <div className="text-xs text-gray-500 mt-2">{validationError}</div>}

      <ModalActions
        onCancel={onClose}
        submitLabel="Save Changes"
        loading={mutation.isPending}
        disabled={!!validationError}
      />
    </form>
  )
}
