import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import ItemPicker from '../ItemPicker'
import { recordSale, recordBundleSale, todayStr, type SaleCostComponent } from '../../lib/mutations'
import { itemUnitsInStock, type ItemWithLots } from '../../lib/queries'
import { formatUSD } from '../../lib/utils'
import { PAYMENT_METHODS } from '../../lib/paymentMethods'

const PLATFORMS = ['ebay', 'amazon', 'tcgplayer', 'mercari', 'stockx', 'goat', 'whatnot', 'manual']

/**
 * An extra item consumed by a line but not priced separately — a remote bought
 * to sell alongside a VHS. It adds to the line's COGS and depletes its own
 * inventory; it never affects the sale price, fees or shipping.
 */
interface Component {
  item: ItemWithLots | null
  quantity: number
}

interface Line {
  item: ItemWithLots | null
  quantity: number
  salePrice: number
  components: Component[]
}

const emptyLine = (): Line => ({ item: null, quantity: 1, salePrice: 0, components: [] })
const emptyComponent = (): Component => ({ item: null, quantity: 1 })

const safeNum = (v: string): number => {
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

/** A line's components in the shape the mutation layer wants. */
const toComponents = (l: Line): SaleCostComponent[] =>
  l.components
    .filter(c => c.item)
    .map(c => ({ itemId: c.item!.id, itemName: c.item!.name, quantity: c.quantity }))

/**
 * One modal for both shapes of sale. A single line records an ordinary sale;
 * adding a second turns the same form into a bundle (one order, several
 * different items, one combined payout) and switches the submit path to
 * recordBundleSale. Fees/shipping are per-sale with one line and order-level
 * with several — the hint text says which.
 *
 * Any line can also carry cost components: extra items included in the sale
 * whose cost counts, but which have no price of their own. That's the axis a
 * bundle doesn't cover — a bundle splits one payout across several priced
 * items, a component adds cost to a single price.
 */
export default function RecordSaleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [lines, setLines] = useState<Line[]>([emptyLine()])
  const [platform, setPlatform] = useState('ebay')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [soldAt, setSoldAt] = useState(todayStr())
  const [fees, setFees] = useState('')
  const [shipping, setShipping] = useState('')
  const [orderId, setOrderId] = useState('')
  const [notes, setNotes] = useState('')
  // Keyed rather than indexed because lines and their components both own
  // pickers: `"2"` is line 2's, `"2:0"` is its first component's.
  const [pickerOpenKey, setPickerOpenKey] = useState<string | null>('0')
  const [error, setError] = useState<string | null>(null)

  const isBundle = lines.length > 1
  const hasComponents = lines.some(l => l.components.length > 0)
  const total = useMemo(() => lines.reduce((s, l) => s + l.salePrice, 0), [lines])
  const netPayout = total - (parseFloat(fees) || 0) - (parseFloat(shipping) || 0)

  const validationError = useMemo(() => {
    for (const l of lines) {
      if (!l.item) return 'Select an inventory item'
      if (l.quantity <= 0) return 'Quantity must be greater than 0'
      if (l.salePrice < 0) return 'Enter a valid sale price'
      for (const c of l.components) {
        if (!c.item) return 'Select an item for each included item'
        if (c.quantity <= 0) return 'Included item quantity must be greater than 0'
      }
    }
    // Components deliberately don't count toward `total` — they cost money,
    // they don't earn any.
    if (total <= 0) return 'Enter a sale price'
    return null
  }, [lines, total])

  const mutation = useMutation({
    mutationFn: async () => {
      if (isBundle) {
        const r = await recordBundleSale({
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
            components: toComponents(l),
          })),
        })
        return { oversoldCount: r.oversoldItemIds.length }
      }
      const l = lines[0]
      const r = await recordSale({
        itemId: l.item!.id,
        itemName: l.item!.name,
        quantity: l.quantity,
        salePrice: l.salePrice,
        platform,
        soldAt,
        externalOrderId: orderId.trim() || null,
        fees: fees ? parseFloat(fees) : null,
        shippingCost: shipping ? parseFloat(shipping) : null,
        paymentMethod: paymentMethod || null,
        components: toComponents(l),
      })
      return { oversoldCount: r.inventoryStatus === 'oversold' ? 1 : 0 }
    },
    onSuccess: ({ oversoldCount }) => {
      // Touches sales, inventory_lots, inventory_movements and transactions — refresh all.
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      if (oversoldCount > 0) {
        setError(`Recorded, but ${oversoldCount} item(s) were oversold. Add purchase lots to reconcile.`)
        setTimeout(() => { reset(); onClose() }, 2600)
      } else {
        reset()
        onClose()
      }
    },
    onError: (e: Error) => setError(e.message),
  })

  function reset() {
    setLines([emptyLine()]); setPlatform('ebay'); setPaymentMethod('')
    setSoldAt(todayStr()); setFees(''); setShipping(''); setOrderId(''); setNotes('')
    setPickerOpenKey('0'); setError(null)
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

  function updateComponent(i: number, ci: number, patch: Partial<Component>) {
    setLines(prev => prev.map((l, idx) => idx !== i ? l : {
      ...l,
      components: l.components.map((c, cIdx) => cIdx === ci ? { ...c, ...patch } : c),
    }))
  }

  function addComponent(i: number) {
    setLines(prev => prev.map((l, idx) => idx !== i ? l : { ...l, components: [...l.components, emptyComponent()] }))
    setPickerOpenKey(`${i}:${lines[i].components.length}`)
  }

  function removeComponent(i: number, ci: number) {
    setLines(prev => prev.map((l, idx) => idx !== i ? l : {
      ...l,
      components: l.components.filter((_, cIdx) => cIdx !== ci),
    }))
    setPickerOpenKey(null)
  }

  const orderScopeHint = isBundle ? 'Optional — applies once, to the whole order' : 'Optional'

  return (
    <Modal open={open} onClose={handleClose} title="Record Sale" width="max-w-2xl">
      <form onSubmit={submit}>
        {/* Items */}
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">
            {isBundle ? `Items (${lines.length})` : 'Item'}
          </h3>
          {isBundle && <span className="text-xs text-gray-500 tabular-nums">Total: {formatUSD(total)}</span>}
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
                    onClick={() => setPickerOpenKey(pickerOpenKey === `${i}` ? null : `${i}`)}
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
                    type="number" min="0" step="0.01" value={l.salePrice || ''} title="Sale price"
                    onChange={e => updateLine(i, { salePrice: safeNum(e.target.value) })}
                    className={inputCls} placeholder="Price"
                  />
                  <button
                    type="button"
                    onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))}
                    className="text-gray-400 hover:text-red-500 p-1.5 disabled:opacity-30"
                    disabled={lines.length === 1}
                    title={lines.length === 1 ? 'A sale needs at least one item' : 'Remove item'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {willOversell && (
                  <div className="flex items-start gap-1.5 text-xs text-amber-700 mt-1.5">
                    <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                    <span>Only {stock} in stock — will be flagged <strong>oversold</strong> until you add inventory.</span>
                  </div>
                )}

                {pickerOpenKey === `${i}` && (
                  <div className="mt-2">
                    <ItemPicker
                      selectedId={l.item?.id ?? null}
                      onSelect={(item) => { updateLine(i, { item }); setPickerOpenKey(null) }}
                    />
                  </div>
                )}

                {/* Cost components — indented to read as subordinate to the line. */}
                {l.components.length > 0 && (
                  <div className="mt-2 pl-3 border-l-2 border-gray-200 space-y-2">
                    <div className="text-[11px] font-medium text-gray-500">
                      Included with this item — cost only, no separate price
                    </div>
                    {l.components.map((c, ci) => {
                      const cStock = c.item ? itemUnitsInStock(c.item) : 0
                      const cWillOversell = c.item != null && c.quantity > cStock
                      const cKey = `${i}:${ci}`
                      return (
                        <div key={ci}>
                          <div className="grid grid-cols-[1fr_70px_28px] gap-2 items-start">
                            <button
                              type="button"
                              onClick={() => setPickerOpenKey(pickerOpenKey === cKey ? null : cKey)}
                              className={`${inputCls} text-left`}
                              aria-label="Select included item"
                            >
                              {c.item?.name ?? <span className="text-gray-400">Pick item…</span>}
                            </button>
                            <input
                              type="number" min="1" step="1" value={c.quantity} title="Quantity"
                              onChange={e => updateComponent(i, ci, { quantity: safeNum(e.target.value) })}
                              className={inputCls}
                            />
                            <button
                              type="button"
                              onClick={() => removeComponent(i, ci)}
                              className="text-gray-400 hover:text-red-500 p-1.5"
                              title="Remove included item"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>

                          {cWillOversell && (
                            <div className="flex items-start gap-1.5 text-xs text-amber-700 mt-1.5">
                              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                              <span>Only {cStock} in stock — will be flagged <strong>oversold</strong> until you add inventory.</span>
                            </div>
                          )}

                          {pickerOpenKey === cKey && (
                            <div className="mt-2">
                              <ItemPicker
                                selectedId={c.item?.id ?? null}
                                onSelect={(item) => { updateComponent(i, ci, { item }); setPickerOpenKey(null) }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => addComponent(i)}
                  className="mt-2 text-xs text-blue-600 hover:underline flex items-center gap-1"
                >
                  <Plus size={12} /> Add included item
                  {l.components.length === 0 && (
                    <span className="text-gray-400">(cost only — adds to COGS, not to the price)</span>
                  )}
                </button>
              </div>
            )
          })}
        </div>

        <button
          type="button"
          onClick={() => { setLines(prev => [...prev, emptyLine()]); setPickerOpenKey(String(lines.length)) }}
          className="mt-2 mb-3 text-xs text-blue-600 hover:underline flex items-center gap-1"
        >
          <Plus size={12} /> Add another item {!isBundle && <span className="text-gray-400">(makes this a bundle sale)</span>}
        </button>

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
          <Field label={isBundle ? 'Order Fees' : 'Platform Fees'} hint={orderScopeHint}>
            <input type="number" step="0.01" min="0" value={fees} onChange={e => setFees(e.target.value)} className={inputCls} placeholder="0.00" />
          </Field>
          <Field label="Shipping Cost" hint={orderScopeHint}>
            <input type="number" step="0.01" min="0" value={shipping} onChange={e => setShipping(e.target.value)} className={inputCls} placeholder="0.00" />
          </Field>
        </div>

        {isBundle && (
          <Field label="Notes" hint="Optional">
            <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
          </Field>
        )}

        {total > 0 && (
          <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600 flex justify-between">
            <span>Net payout after fees &amp; shipping</span>
            <span className="font-semibold text-gray-900">{formatUSD(netPayout)}</span>
          </div>
        )}

        <p className="text-xs text-gray-400 mt-3">
          {isBundle
            ? 'Each item FIFO-depletes its own inventory and keeps its own profit. Fees and shipping apply once, to the whole order.'
            : 'Recording a sale will: deplete inventory lots (FIFO), create inventory movement records, and auto-create payout/fee/shipping transactions for Schedule C.'}
          {hasComponents && ' Included items FIFO-deplete their own inventory too, and their cost is added to COGS.'}
        </p>

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
        {validationError && !error && <div className="text-xs text-gray-500 mt-2">{validationError}</div>}

        <ModalActions
          onCancel={handleClose}
          submitLabel={isBundle ? 'Record Bundle Sale' : 'Record Sale'}
          loading={mutation.isPending}
          disabled={!!validationError}
        />
      </form>
    </Modal>
  )
}
