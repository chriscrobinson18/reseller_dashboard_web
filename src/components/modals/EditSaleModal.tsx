import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { updateSale } from '../../lib/mutations'
import { formatUSD } from '../../lib/utils'
import { paymentSplitRowsFromSale, resolvePaymentSplits, type PaymentSplitRow } from '../../lib/paymentMethods'
import PaymentSplitsField from '../PaymentSplitsField'
import type { Sale } from '../../lib/types'

const PLATFORMS = ['ebay', 'amazon', 'tcgplayer', 'mercari', 'stockx', 'goat', 'whatnot', 'manual']

interface Props {
  open: boolean
  onClose: () => void
  sale: Sale
}

export default function EditSaleModal({ open, onClose, sale }: Props) {
  const qc = useQueryClient()
  const isBundleLine = !!sale.bundle_id
  const [platform, setPlatform] = useState(sale.platform ?? 'ebay')
  const [quantity, setQuantity] = useState(String(sale.quantity))
  const [salePrice, setSalePrice] = useState(String(sale.sale_price))
  const [soldAt, setSoldAt] = useState(sale.sold_at.slice(0, 10))
  const [orderId, setOrderId] = useState(sale.external_order_id ?? '')
  const [paymentRows, setPaymentRows] = useState<PaymentSplitRow[]>(() => paymentSplitRowsFromSale(sale.payment_method, sale.payment_methods))
  const [fees, setFees] = useState(sale.fees ? String(sale.fees) : '')
  const [shipping, setShipping] = useState(sale.shipping_cost != null ? String(sale.shipping_cost) : '')
  const [error, setError] = useState<string | null>(null)

  const { paymentMethod, paymentMethods } = useMemo(() => resolvePaymentSplits(paymentRows), [paymentRows])

  const mutation = useMutation({
    mutationFn: () => updateSale({
      id: sale.id,
      source: sale.source,
      platform,
      quantity: parseInt(quantity, 10),
      salePrice: parseFloat(salePrice),
      soldAt,
      externalOrderId: orderId.trim() || null,
      fees: fees ? parseFloat(fees) : null,
      shippingCost: shipping ? parseFloat(shipping) : null,
      paymentMethod,
      paymentMethods,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const q = parseInt(quantity, 10)
    const p = parseFloat(salePrice)
    if (!q || q <= 0) { setError('Quantity must be greater than 0'); return }
    if (isNaN(p) || p < 0) { setError('Enter a valid sale price'); return }
    if (paymentMethods) {
      if (paymentMethods.some(pm => pm.amount <= 0)) { setError('Enter an amount for every payment method'); return }
      if (Math.abs(paymentMethods.reduce((s, pm) => s + pm.amount, 0) - p) >= 0.005) {
        setError('Payment method amounts must add up to the sale price'); return
      }
    }
    mutation.mutate()
  }

  const netPayout = (parseFloat(salePrice) || 0) - (parseFloat(fees) || 0) - (parseFloat(shipping) || 0)

  return (
    <Modal open={open} onClose={onClose} title="Edit Sale" width="max-w-lg">
      <form onSubmit={submit}>
        {isBundleLine ? (
          <p className="text-xs text-gray-400 mb-3">
            Part of a bundle — date, platform, fees and shipping are edited from the bundle (Open bundle, above).
          </p>
        ) : sale.source === 'manual' && (
          <p className="text-xs text-gray-400 mb-3">
            Linked payout / fee / shipping transactions will be updated to match.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {!isBundleLine && (
            <>
              <Field label="Platform">
                <select value={platform} onChange={e => setPlatform(e.target.value)} className={inputCls + ' capitalize bg-white'}>
                  {PLATFORMS.map(p => <option key={p} value={p} className="capitalize">{p}</option>)}
                </select>
              </Field>
              <PaymentSplitsField platform={platform} total={parseFloat(salePrice) || 0} rows={paymentRows} onChange={setPaymentRows} />
              <Field label="Sale Date">
                <input type="date" value={soldAt} onChange={e => setSoldAt(e.target.value)} className={inputCls} />
              </Field>
            </>
          )}
          <Field label="Quantity">
            <input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Sale Price">
            <input type="number" step="0.01" min="0" value={salePrice} onChange={e => setSalePrice(e.target.value)} className={inputCls} />
          </Field>
          {!isBundleLine && (
            <>
              <Field label="Platform Fees">
                <input type="number" step="0.01" min="0" value={fees} onChange={e => setFees(e.target.value)} className={inputCls} placeholder="0.00" />
              </Field>
              <Field label="Shipping Cost">
                <input type="number" step="0.01" min="0" value={shipping} onChange={e => setShipping(e.target.value)} className={inputCls} placeholder="0.00" />
              </Field>
            </>
          )}
        </div>
        {!isBundleLine && (
          <Field label="Order ID" hint="Optional">
            <input value={orderId} onChange={e => setOrderId(e.target.value)} className={inputCls} />
          </Field>
        )}

        {!isBundleLine && (
          <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600 flex justify-between">
            <span>Net payout after fees &amp; shipping</span>
            <span className="font-semibold text-gray-900">{formatUSD(netPayout)}</span>
          </div>
        )}

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
        <ModalActions onCancel={onClose} submitLabel="Save Changes" loading={mutation.isPending} />
      </form>
    </Modal>
  )
}
