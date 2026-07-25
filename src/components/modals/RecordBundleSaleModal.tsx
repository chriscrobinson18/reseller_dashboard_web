import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, AlertTriangle } from 'lucide-react'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import ItemPicker from '../ItemPicker'
import { recordBundleSale, todayStr } from '../../lib/mutations'
import { itemUnitsInStock, type ItemWithLots } from '../../lib/queries'
import { formatUSD } from '../../lib/utils'
import { PAYMENT_METHODS } from '../../lib/paymentMethods'

const PLATFORMS = ['ebay', 'amazon', 'tcgplayer', 'mercari', 'stockx', 'goat', 'whatnot', 'manual']

interface Line {
  item: ItemWithLots | null
  quantity: number
  salePrice: number
}

const emptyLine = (): Line => ({ item: null, quantity: 1, salePrice: 0 })

const safeNum = (v: string): number => {
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function RecordBundleSaleModal({ open, onClose }: Props) {
  const qc = useQueryClient()
  const [soldAt, setSoldAt] = useState(todayStr())
  const [platform, setPlatform] = useState('ebay')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [orderId, setOrderId] = useState('')
  const [fees, setFees] = useState('')
  const [shipping, setShipping] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()])
  const [pickerOpenIdx, setPickerOpenIdx] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const total = useMemo(() => lines.reduce((s, l) => s + l.salePrice, 0), [lines])
  const netPayout = total - (parseFloat(fees) || 0) - (parseFloat(shipping) || 0)

  const validationError = useMemo(() => {
    if (lines.length < 2) return 'A bundle needs at least 2 items'
    for (const l of lines) {
      if (!l.item) return 'Pick an item for every line'
      if (l.quantity <= 0) return 'Quantity must be greater than 0 on every line'
      if (l.salePrice < 0) return 'Sale price must be >= 0'
    }
    if (total <= 0) return 'Total sale price must be greater than 0'
    return null
  }, [lines, total])

  const mutation = useMutation({
    mutationFn: () => recordBundleSale({
      soldAt,
      platform,
      paymentMethod: paymentMethod || null,
      externalOrderId: orderId.trim() || null,
      fees: fees ? parseFloat(fees) : null,
      shippingCost: shipping ? parseFloat(shipping) : null,
      notes: notes.trim() || null,
      items: lines.map(l => ({
        itemId: l.item!.id,
        itemName: l.item!.name,
        quantity: l.quantity,
        salePrice: l.salePrice,
      })),
    }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      if (result.oversoldItemIds.length > 0) {
        setError(`Bundle recorded, but ${result.oversoldItemIds.length} item(s) were oversold. Add purchase lots to reconcile.`)
        setTimeout(() => { reset(); onClose() }, 2800)
      } else {
        reset()
        onClose()
      }
    },
    onError: (e: Error) => setError(e.message),
  })

  function reset() {
    setSoldAt(todayStr()); setPlatform('ebay'); setPaymentMethod('')
    setOrderId(''); setFees(''); setShipping(''); setNotes('')
    setLines([emptyLine(), emptyLine()]); setPickerOpenIdx(null); setError(null)
    mutation.reset()
  }

  function handleClose() { reset(); onClose() }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (validationError) return
    mutation.mutate()
  }

  function updateLine(i: number, patch: Partial<Line>) {
    setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  }

  return (
    <Modal open={open} onClose={handleClose} title="Record Bundle Sale" width="max-w-2xl">
      <form onSubmit={submit}>
        <p className="text-xs text-gray-500 mb-3">
          One order, several different items, one combined payout — e.g. a multi-item eBay order
          or an in-person sale of a mixed lot. Each item still FIFO-depletes its own inventory
          and drives its own profit; fees and shipping apply once, to the whole order.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Sale Date">
            <input type="date" value={soldAt} onChange={e => setSoldAt(e.target.value)} className={inputCls} />
          </Field>
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
          <Field label="Order ID" hint="Optional">
            <input value={orderId} onChange={e => setOrderId(e.target.value)} className={inputCls} placeholder="e.g. 01-12345-67890" />
          </Field>
          <Field label="Order Fees" hint="Optional — applies once, to the whole order">
            <input type="number" step="0.01" min="0" value={fees} onChange={e => setFees(e.target.value)} className={inputCls} placeholder="0.00" />
          </Field>
          <Field label="Shipping Cost" hint="Optional — applies once, to the whole order">
            <input type="number" step="0.01" min="0" value={shipping} onChange={e => setShipping(e.target.value)} className={inputCls} placeholder="0.00" />
          </Field>
        </div>

        {/* Line items */}
        <div className="mt-4 mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Items</h3>
          <span className="text-xs text-gray-500 tabular-nums">Total: {formatUSD(total)}</span>
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => {
            const stock = l.item ? itemUnitsInStock(l.item) : 0
            const willOversell = l.item != null && l.quantity > stock
            return (
              <div key={i} className="border border-gray-200 rounded-lg p-3">
                <div className="grid grid-cols-[1fr_70px_100px_28px] gap-2 items-start">
                  <button
                    type="button"
                    onClick={() => setPickerOpenIdx(i)}
                    className={`${inputCls} text-left`}
                    aria-label="Select item"
                  >
                    {l.item?.name ?? <span className="text-gray-400">Pick item…</span>}
                  </button>
                  <input
                    type="number" min="1" step="1" value={l.quantity} title="Quantity"
                    onChange={e => updateLine(i, { quantity: safeNum(e.target.value) })}
                    className={inputCls}
                  />
                  <input
                    type="number" min="0" step="0.01" value={l.salePrice} title="Sale price (line total)"
                    onChange={e => updateLine(i, { salePrice: safeNum(e.target.value) })}
                    className={inputCls} placeholder="Price"
                  />
                  <button
                    type="button"
                    onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))}
                    className="text-gray-400 hover:text-red-500 p-1.5"
                    disabled={lines.length <= 2}
                    title={lines.length <= 2 ? 'A bundle needs at least 2 items' : 'Remove line'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {willOversell && (
                  <div className="flex items-center gap-1.5 text-xs text-amber-700 mt-1.5">
                    <AlertTriangle size={12} className="shrink-0" />
                    Only {stock} in stock — will be flagged oversold.
                  </div>
                )}

                {pickerOpenIdx === i && (
                  <div className="mt-2">
                    <ItemPicker
                      selectedId={l.item?.id ?? null}
                      onSelect={(item) => { updateLine(i, { item }); setPickerOpenIdx(null) }}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <button type="button" onClick={() => setLines(prev => [...prev, emptyLine()])} className="mt-2 text-xs text-blue-600 hover:underline flex items-center gap-1">
          <Plus size={12} /> Add line
        </button>

        <Field label="Notes" hint="Optional">
          <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
        </Field>

        {total > 0 && (
          <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600 flex justify-between mt-1">
            <span>Net payout after fees & shipping</span>
            <span className="font-semibold text-gray-900">{formatUSD(netPayout)}</span>
          </div>
        )}

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
        {validationError && !error && <div className="text-xs text-gray-500 mt-2">{validationError}</div>}

        <ModalActions onCancel={handleClose} submitLabel="Record Bundle Sale" loading={mutation.isPending} disabled={!!validationError} />
      </form>
    </Modal>
  )
}
