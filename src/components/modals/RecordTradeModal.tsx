import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import InfoPopover from '../InfoPopover'
import ItemPicker from '../ItemPicker'
import { recordTrade, todayStr } from '../../lib/mutations'
import { itemUnitsInStock, type ItemWithLots } from '../../lib/queries'
import { formatUSD } from '../../lib/utils'

interface GivenLine {
  itemId: string | null
  itemName: string | null              // cached for display
  quantity: number
  fmv: number
}

interface ReceivedLine {
  itemId: string | null
  itemName: string | null              // for inline-created items, the typed name
  isNew: boolean                       // true => create new item on submit
  newItemCategory: string | null
  quantity: number
  fmv: number
}

const emptyGiven = (): GivenLine => ({ itemId: null, itemName: null, quantity: 1, fmv: 0 })
const emptyReceived = (): ReceivedLine => ({ itemId: null, itemName: null, isNew: false, newItemCategory: null, quantity: 1, fmv: 0 })

// Fix 1: guard against NaN from partial numeric input (e.g. "-" or ".")
const safeNum = (v: string): number => {
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function RecordTradeModal({ open, onClose }: Props) {
  const qc = useQueryClient()
  const [tradedAt, setTradedAt] = useState(todayStr())
  const [counterparty, setCounterparty] = useState('')
  const [fmvSourceNotes, setFmvSourceNotes] = useState('')
  const [notes, setNotes] = useState('')
  const [given, setGiven] = useState<GivenLine[]>([emptyGiven()])
  const [received, setReceived] = useState<ReceivedLine[]>([emptyReceived()])
  const [bootOpen, setBootOpen] = useState(false)
  const [bootDirection, setBootDirection] = useState<'paid' | 'received'>('paid')
  const [bootAmount, setBootAmount] = useState(0)
  const [pickerOpenIdx, setPickerOpenIdx] = useState<{ side: 'given' | 'received'; idx: number } | null>(null)

  const cashBoot = bootOpen && bootAmount > 0 ? (bootDirection === 'received' ? bootAmount : -bootAmount) : 0

  const givenFmv = useMemo(() => given.reduce((s, l) => s + l.fmv * l.quantity, 0), [given])
  const receivedFmv = useMemo(() => received.reduce((s, l) => s + l.fmv * l.quantity, 0), [received])
  const cashPaid = Math.max(-cashBoot, 0)
  const cashReceived = Math.max(cashBoot, 0)
  const lhs = givenFmv + cashPaid
  const rhs = receivedFmv + cashReceived
  const delta = lhs - rhs
  const balanced = Math.abs(delta) < 0.01

  const validationError = useMemo(() => {
    if (given.length === 0) return 'Add at least one item you gave'
    if (received.length === 0) return 'Add at least one item you received'
    for (const g of given) {
      if (!g.itemId) return 'Pick an item for every "You gave" line'
      if (g.quantity <= 0) return 'Quantity must be > 0 on every line'
      if (g.fmv < 0) return 'FMV must be >= 0'
    }
    for (const r of received) {
      if (!r.itemId && !r.itemName) return 'Pick or name an item for every "You received" line'
      if (r.quantity <= 0) return 'Quantity must be > 0 on every line'
      if (r.fmv < 0) return 'FMV must be >= 0'
    }
    if (!balanced) return `Trade is off by ${formatUSD(Math.abs(delta))} — add a cash boot or adjust an FMV`
    return null
  }, [given, received, balanced, delta])

  const m = useMutation({
    mutationFn: () => recordTrade({
      tradedAt,
      counterparty: counterparty.trim() || null,
      notes: notes.trim() || null,
      fmvSourceNotes: fmvSourceNotes.trim() || null,
      cashBoot,
      given: given.map(g => ({
        itemId: g.itemId!,
        quantity: g.quantity,
        fmv: g.fmv,
      })),
      received: received.map(r => ({
        itemId: r.isNew ? null : r.itemId,
        newItemName: r.isNew ? r.itemName : null,
        newItemCategory: r.isNew ? r.newItemCategory : null,
        quantity: r.quantity,
        fmv: r.fmv,
      })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['trade'] })
      reset()
      onClose()
    },
  })

  // Fix 2: reset all state on close so reopening the modal starts fresh
  const reset = () => {
    setTradedAt(todayStr())
    setCounterparty('')
    setFmvSourceNotes('')
    setNotes('')
    setGiven([emptyGiven()])
    setReceived([emptyReceived()])
    setBootOpen(false)
    setBootDirection('paid')
    setBootAmount(0)
    setPickerOpenIdx(null)
    m.reset()
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (validationError) return
    m.mutate()
  }

  const updateGiven = (i: number, patch: Partial<GivenLine>) =>
    setGiven(prev => prev.map((g, idx) => idx === i ? { ...g, ...patch } : g))
  const updateReceived = (i: number, patch: Partial<ReceivedLine>) =>
    setReceived(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r))

  return (
    <Modal open={open} onClose={handleClose} title="Record Trade" width="max-w-2xl">
      <form onSubmit={submit}>
        <div className="flex justify-end -mt-2 mb-2">
          <InfoPopover label="How trades work" width="w-[360px]">
            <HelpContent />
          </InfoPopover>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Trade date">
            <input type="date" value={tradedAt} onChange={e => setTradedAt(e.target.value)} className={inputCls} required />
          </Field>
          <Field label="Counterparty (optional)">
            <input value={counterparty} onChange={e => setCounterparty(e.target.value)} placeholder="e.g. John D. on IG" className={inputCls} />
          </Field>
        </div>
        <Field label="FMV source notes" hint="Recommended for IRS defensibility">
          <input value={fmvSourceNotes} onChange={e => setFmvSourceNotes(e.target.value)} placeholder="e.g. eBay sold comps saved" className={inputCls} />
        </Field>
        <Field label="Notes (optional)">
          <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
        </Field>

        {/* You gave */}
        <div className="mt-4 mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">You gave</h3>
          <span className="text-xs text-gray-500 tabular-nums">Subtotal: {formatUSD(givenFmv)}</span>
        </div>
        <div className="space-y-2">
          {given.map((g, i) => (
            <div key={i} className="border border-gray-200 rounded-lg p-3">
              <div className="grid grid-cols-[1fr_70px_90px_28px] gap-2 items-start">
                <div>
                  {/* Fix 4: aria-label on given-side picker trigger */}
                  <button type="button" onClick={() => setPickerOpenIdx({ side: 'given', idx: i })} className={`${inputCls} text-left`} aria-label="Select item to give">
                    {g.itemName ?? <span className="text-gray-400">Pick item with stock…</span>}
                  </button>
                </div>
                {/* Fix 1: safeNum for given quantity */}
                <input type="number" min="1" step="1" value={g.quantity} onChange={e => updateGiven(i, { quantity: safeNum(e.target.value) })} className={inputCls} title="Quantity" />
                {/* Fix 1: safeNum for given fmv */}
                <input type="number" min="0" step="0.01" value={g.fmv} onChange={e => updateGiven(i, { fmv: safeNum(e.target.value) })} className={inputCls} title="FMV per unit" placeholder="$/unit" />
                <button type="button" onClick={() => setGiven(prev => prev.filter((_, idx) => idx !== i))} className="text-gray-400 hover:text-red-500 p-1.5" disabled={given.length === 1}>
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="text-xs text-gray-500 mt-1 tabular-nums">Line FMV: {formatUSD(g.fmv * g.quantity)}</div>

              {pickerOpenIdx?.side === 'given' && pickerOpenIdx.idx === i && (
                <div className="mt-2">
                  <ItemPicker
                    selectedId={g.itemId}
                    filter={(item: ItemWithLots) => itemUnitsInStock(item) > 0}
                    onSelect={(item) => {
                      updateGiven(i, { itemId: item.id, itemName: item.name })
                      setPickerOpenIdx(null)
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setGiven(prev => [...prev, emptyGiven()])} className="mt-2 text-xs text-blue-600 hover:underline flex items-center gap-1">
          <Plus size={12} /> Add line
        </button>

        {/* You received */}
        <div className="mt-5 mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">You received</h3>
          <span className="text-xs text-gray-500 tabular-nums">Subtotal: {formatUSD(receivedFmv)}</span>
        </div>
        <div className="space-y-2">
          {received.map((r, i) => (
            <div key={i} className="border border-gray-200 rounded-lg p-3">
              <div className="grid grid-cols-[1fr_70px_90px_28px] gap-2 items-start">
                <div>
                  {/* Fix 3: inline input when isNew, otherwise picker trigger */}
                  {r.isNew ? (
                    <input
                      type="text"
                      value={r.itemName ?? ''}
                      onChange={e => updateReceived(i, { itemName: e.target.value })}
                      placeholder="New item name"
                      autoFocus
                      className={inputCls}
                      aria-label="New received item name"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPickerOpenIdx({ side: 'received', idx: i })}
                      className={`${inputCls} text-left`}
                      aria-label="Select item to receive"
                    >
                      {r.itemName ?? <span className="text-gray-400">Pick or create item…</span>}
                    </button>
                  )}
                </div>
                {/* Fix 1: safeNum for received quantity */}
                <input type="number" min="1" step="1" value={r.quantity} onChange={e => updateReceived(i, { quantity: safeNum(e.target.value) })} className={inputCls} title="Quantity" />
                {/* Fix 1: safeNum for received fmv */}
                <input type="number" min="0" step="0.01" value={r.fmv} onChange={e => updateReceived(i, { fmv: safeNum(e.target.value) })} className={inputCls} title="FMV per unit" placeholder="$/unit" />
                <button type="button" onClick={() => setReceived(prev => prev.filter((_, idx) => idx !== i))} className="text-gray-400 hover:text-red-500 p-1.5" disabled={received.length === 1}>
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="text-xs text-gray-500 mt-1 tabular-nums">Line FMV: {formatUSD(r.fmv * r.quantity)}</div>

              {pickerOpenIdx?.side === 'received' && pickerOpenIdx.idx === i && (
                <div className="mt-2">
                  <ItemPicker
                    selectedId={r.itemId}
                    onSelect={(item) => {
                      updateReceived(i, { itemId: item.id, itemName: item.name, isNew: false })
                      setPickerOpenIdx(null)
                    }}
                    onCreateNew={() => {
                      // Fix 3: no window.prompt — set isNew and let user type inline
                      updateReceived(i, { itemId: null, itemName: '', isNew: true })
                      setPickerOpenIdx(null)
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setReceived(prev => [...prev, emptyReceived()])} className="mt-2 text-xs text-blue-600 hover:underline flex items-center gap-1">
          <Plus size={12} /> Add line
        </button>

        {/* Cash boot */}
        <div className="mt-5 border-t border-gray-100 pt-4">
          <button type="button" onClick={() => setBootOpen(o => !o)} className="flex items-center gap-1 text-sm font-medium text-gray-700">
            {bootOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Cash changed hands?
          </button>
          {bootOpen && (
            <div className="grid grid-cols-2 gap-3 mt-2">
              <Field label="Direction">
                <div className="flex gap-1">
                  <button type="button" onClick={() => setBootDirection('paid')} className={`flex-1 py-2 text-xs rounded-lg border ${bootDirection === 'paid' ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'}`}>I paid</button>
                  <button type="button" onClick={() => setBootDirection('received')} className={`flex-1 py-2 text-xs rounded-lg border ${bootDirection === 'received' ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'}`}>I received</button>
                </div>
              </Field>
              <Field label="Amount ($)">
                {/* Fix 1: safeNum for boot amount */}
                <input type="number" min="0" step="0.01" value={bootAmount} onChange={e => setBootAmount(safeNum(e.target.value))} className={inputCls} />
              </Field>
            </div>
          )}
        </div>

        {/* Balance display */}
        <div className={`mt-4 p-3 rounded-lg text-xs tabular-nums ${balanced ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          <div>Given {formatUSD(givenFmv)} {cashPaid > 0 && `+ Paid ${formatUSD(cashPaid)}`} = Received {formatUSD(receivedFmv)} {cashReceived > 0 && `+ Cash in ${formatUSD(cashReceived)}`}</div>
          {!balanced && <div className="mt-1 font-semibold">Off by {formatUSD(Math.abs(delta))}</div>}
        </div>

        {m.isError && <div className="mt-2 text-xs text-red-600">{(m.error as Error).message}</div>}
        {validationError && !m.isError && <div className="mt-2 text-xs text-gray-500">{validationError}</div>}

        <ModalActions onCancel={handleClose} submitLabel="Record trade" loading={m.isPending} disabled={!!validationError} />
      </form>
    </Modal>
  )
}

function HelpContent() {
  return (
    <div className="space-y-3 leading-relaxed">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Recording a trade</h3>
        <p>
          A trade is treated as a barter sale under IRS rules — both sides are recorded at fair
          market value (FMV), and the trade itself anchors the transaction price.
        </p>
      </div>

      <div>
        <p>
          <strong>You gave</strong> — items leaving your inventory. Each becomes a Sale at the FMV you
          enter, FIFO-depleting the underlying lot.
        </p>
      </div>

      <div>
        <p>
          <strong>You received</strong> — items entering your inventory. Each becomes a new lot with
          cost basis = the FMV you enter. Pick an existing item or create a new one inline.
        </p>
      </div>

      <div>
        <p>
          <strong>Cash boot</strong> — optional cash that balances the trade. The balance rule is:
        </p>
        <pre className="mt-1 bg-gray-50 px-2 py-1.5 rounded text-[11px] whitespace-pre-wrap">
Given total + cash you paid = Received total + cash you received
        </pre>
        <p className="mt-1">
          The balance footer turns green when this holds. Submit is disabled otherwise.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">What gets posted to Schedule C</h3>
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 pr-2 font-medium">Component</th>
              <th className="py-1 pr-2 font-medium">Amount</th>
              <th className="py-1 font-medium">Cash?</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-gray-100">
              <td className="py-1 pr-2">Non-cash income</td>
              <td className="py-1 pr-2">given − cash received</td>
              <td className="py-1">non-cash</td>
            </tr>
            <tr className="border-t border-gray-100">
              <td className="py-1 pr-2">Non-cash COGS</td>
              <td className="py-1 pr-2">same (always washes)</td>
              <td className="py-1">non-cash</td>
            </tr>
            <tr className="border-t border-gray-100">
              <td className="py-1 pr-2">Cash boot</td>
              <td className="py-1 pr-2">signed</td>
              <td className="py-1">real bank txn</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-1">
          The two non-cash legs cancel each other; only the cash boot moves your Schedule C totals
          at trade time. The deferred gain materializes later when received items are sold.
        </p>
      </div>

      <div>
        <p>
          <strong>FMV source notes</strong> — recommended for IRS defensibility. Save a quick
          reference (e.g. "eBay sold comps screenshot 2026-06-24").
        </p>
      </div>

      <div>
        <p>
          <strong>Editing</strong> — trades are read-only after creation. To change one, delete it
          from the Trade detail drawer and re-record. Delete blocks if you've already sold any
          received items.
        </p>
      </div>
    </div>
  )
}
