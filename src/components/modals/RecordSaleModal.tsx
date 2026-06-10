import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import ItemPicker from '../ItemPicker'
import { recordSale, todayStr } from '../../lib/mutations'
import { itemUnitsInStock, type ItemWithLots } from '../../lib/queries'
import { formatUSD } from '../../lib/utils'

const PLATFORMS = ['ebay', 'amazon', 'tcgplayer', 'mercari', 'stockx', 'goat', 'whatnot', 'manual']

export default function RecordSaleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [item, setItem] = useState<ItemWithLots | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [salePrice, setSalePrice] = useState('')
  const [platform, setPlatform] = useState('ebay')
  const [soldAt, setSoldAt] = useState(todayStr())
  const [fees, setFees] = useState('')
  const [shipping, setShipping] = useState('')
  const [orderId, setOrderId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => recordSale({
      itemId: item!.id,
      itemName: item!.name,
      quantity: parseInt(quantity, 10),
      salePrice: parseFloat(salePrice),
      platform,
      soldAt,
      externalOrderId: orderId.trim() || null,
      fees: fees ? parseFloat(fees) : null,
      shippingCost: shipping ? parseFloat(shipping) : null,
    }),
    onSuccess: (result) => {
      // Touches sales, inventory_lots, inventory_movements and transactions — refresh all.
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      if (result.inventoryStatus === 'oversold') {
        setError(`Sale recorded, but inventory was oversold by ${result.unfulfilledQuantity}. Add a purchase lot to reconcile.`)
        setTimeout(() => { reset(); onClose() }, 2500)
      } else {
        reset()
        onClose()
      }
    },
    onError: (e: Error) => setError(e.message),
  })

  function reset() {
    setItem(null); setQuantity('1'); setSalePrice(''); setPlatform('ebay')
    setSoldAt(todayStr()); setFees(''); setShipping(''); setOrderId(''); setError(null)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!item) { setError('Select an inventory item'); return }
    const q = parseInt(quantity, 10)
    const p = parseFloat(salePrice)
    if (!q || q <= 0) { setError('Quantity must be greater than 0'); return }
    if (isNaN(p) || p < 0) { setError('Enter a valid sale price'); return }
    mutation.mutate()
  }

  const stock = item ? itemUnitsInStock(item) : 0
  const willOversell = item != null && parseInt(quantity, 10) > stock
  const netPayout = (parseFloat(salePrice) || 0) - (parseFloat(fees) || 0) - (parseFloat(shipping) || 0)

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title="Record Sale" width="max-w-lg">
      <form onSubmit={submit}>
        <Field label="Inventory Item" hint="FIFO depletion will use the oldest lots first.">
          <ItemPicker selectedId={item?.id ?? null} onSelect={setItem} />
        </Field>

        {willOversell && (
          <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>Only {stock} in stock. This sale will be flagged <strong>oversold</strong> until you add inventory.</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity">
            <input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Sale Price">
            <input type="number" step="0.01" min="0" value={salePrice} onChange={e => setSalePrice(e.target.value)} className={inputCls} placeholder="0.00" />
          </Field>
          <Field label="Platform">
            <select value={platform} onChange={e => setPlatform(e.target.value)} className={inputCls + ' capitalize bg-white'}>
              {PLATFORMS.map(p => <option key={p} value={p} className="capitalize">{p}</option>)}
            </select>
          </Field>
          <Field label="Sale Date">
            <input type="date" value={soldAt} onChange={e => setSoldAt(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Platform Fees" hint="Optional">
            <input type="number" step="0.01" min="0" value={fees} onChange={e => setFees(e.target.value)} className={inputCls} placeholder="0.00" />
          </Field>
          <Field label="Shipping Cost" hint="Optional">
            <input type="number" step="0.01" min="0" value={shipping} onChange={e => setShipping(e.target.value)} className={inputCls} placeholder="0.00" />
          </Field>
        </div>
        <Field label="Order ID" hint="Optional — platform order number">
          <input value={orderId} onChange={e => setOrderId(e.target.value)} className={inputCls} placeholder="e.g. 01-12345-67890" />
        </Field>

        {(parseFloat(salePrice) || 0) > 0 && (
          <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600 flex justify-between">
            <span>Net payout after fees & shipping</span>
            <span className="font-semibold text-gray-900">{formatUSD(netPayout)}</span>
          </div>
        )}

        <p className="text-xs text-gray-400 mt-3">
          Recording a sale will: deplete inventory lots (FIFO), create inventory movement records, and auto-create
          payout/fee/shipping transactions for Schedule&nbsp;C.
        </p>

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
        <ModalActions onCancel={() => { reset(); onClose() }} submitLabel="Record Sale" loading={mutation.isPending} />
      </form>
    </Modal>
  )
}
