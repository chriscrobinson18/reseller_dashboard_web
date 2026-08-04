import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import InfoPopover from '../InfoPopover'
import ItemPicker from '../ItemPicker'
import { openBox, todayStr } from '../../lib/mutations'
import { allocateBoxCost, type BoxAllocationMethod } from '../../lib/boxAllocation'
import { formatUSD } from '../../lib/utils'

interface CardLine {
  itemId: string | null
  itemName: string | null       // cached for display, or the typed name when isNew
  isNew: boolean
  newItemCategory: string | null
  value: number                 // relative_fmv weight, or specific_id $ — ignored for equal
}

const emptyCard = (): CardLine => ({ itemId: null, itemName: null, isNew: false, newItemCategory: null, value: 0 })

const safeNum = (v: string): number => {
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

const METHODS: Array<{ value: BoxAllocationMethod; label: string }> = [
  { value: 'relative_fmv', label: 'Relative value' },
  { value: 'equal', label: 'Equal split' },
  { value: 'specific_id', label: 'Specific $' },
]

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * Opens a sealed box: one cost splits into a lot per card. See
 * docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md.
 */
export default function OpenBoxModal({ open, onClose }: Props) {
  const qc = useQueryClient()
  const [boxName, setBoxName] = useState('')
  const [boxCost, setBoxCost] = useState(0)
  const [openedAt, setOpenedAt] = useState(todayStr)
  const [merchant, setMerchant] = useState('')
  const [notes, setNotes] = useState('')
  const [method, setMethod] = useState<BoxAllocationMethod>('relative_fmv')
  const [cards, setCards] = useState<CardLine[]>([emptyCard(), emptyCard()])
  const [pickerOpenIdx, setPickerOpenIdx] = useState<number | null>(null)

  const allocation = useMemo(
    () => allocateBoxCost(boxCost, method, cards.map(c => ({ value: c.value }))),
    [boxCost, method, cards],
  )

  const specificSum = useMemo(
    () => (method === 'specific_id' ? cards.reduce((s, c) => s + (c.value || 0), 0) : 0),
    [method, cards],
  )

  const validationError = useMemo(() => {
    if (!boxName.trim()) return 'Name the box'
    if (!(boxCost > 0)) return 'Box cost must be greater than 0'
    if (!openedAt) return 'Pick the date the box was opened'
    if (cards.length === 0) return 'Add at least one card'
    for (const c of cards) {
      if (!c.itemId && !c.itemName?.trim()) return 'Pick or name an item for every card'
    }
    if (method === 'specific_id' && Math.abs(specificSum - boxCost) > 0.01) {
      return `Card costs (${formatUSD(specificSum)}) must sum to the box cost (${formatUSD(boxCost)})`
    }
    return null
  }, [boxName, boxCost, openedAt, cards, method, specificSum])

  const m = useMutation({
    mutationFn: () => openBox({
      openedAt,
      boxName: boxName.trim(),
      boxCost,
      allocationMethod: method,
      notes: notes.trim() || null,
      merchant: merchant.trim() || null,
      cards: cards.map((c, i) => ({
        itemId: c.isNew ? null : c.itemId,
        newItemName: c.isNew ? c.itemName : null,
        newItemCategory: c.isNew ? c.newItemCategory : null,
        basis: allocation.basis[i] ?? 0,
      })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['box-opening'] })
      reset()
      onClose()
    },
  })

  function reset() {
    setBoxName(''); setBoxCost(0); setOpenedAt(todayStr()); setMerchant(''); setNotes('')
    setMethod('relative_fmv'); setCards([emptyCard(), emptyCard()]); setPickerOpenIdx(null)
    m.reset()
  }

  function handleClose() { reset(); onClose() }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (validationError) return
    m.mutate()
  }

  const updateCard = (i: number, patch: Partial<CardLine>) =>
    setCards(prev => prev.map((c, idx) => idx === i ? { ...c, ...patch } : c))

  return (
    <Modal open={open} onClose={handleClose} title="Open Box" width="max-w-2xl">
      <form onSubmit={submit}>
        <div className="flex justify-end -mt-2 mb-2">
          <InfoPopover label="How box opening works" width="w-[360px]">
            <HelpContent />
          </InfoPopover>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Box name">
            <input
              value={boxName} onChange={e => setBoxName(e.target.value)}
              placeholder="2024 Topps Series 1 Hobby Box" className={inputCls}
            />
          </Field>
          <Field label="Box cost">
            <input
              type="number" min="0" step="0.01" value={boxCost || ''}
              onChange={e => setBoxCost(safeNum(e.target.value))} placeholder="0.00" className={inputCls}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Opened on">
            <input type="date" value={openedAt} onChange={e => setOpenedAt(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Merchant" hint="Optional — defaults to box name">
            <input value={merchant} onChange={e => setMerchant(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <Field label="Notes" hint="Optional">
          <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
        </Field>

        <Field label="Allocation method" hint="How the box cost splits across the cards below">
          <div className="flex gap-1.5">
            {METHODS.map(mo => (
              <button
                key={mo.value}
                type="button"
                onClick={() => setMethod(mo.value)}
                className={`flex-1 text-xs px-2 py-1.5 rounded-lg border transition-colors ${
                  method === mo.value
                    ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {mo.label}
              </button>
            ))}
          </div>
        </Field>

        {method === 'relative_fmv' && allocation.fellBackToEqual && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
            All est. values are 0 — falling back to an equal split.
          </div>
        )}

        {/* Cards */}
        <div className="mt-3 mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Cards</h3>
          <span className="text-xs text-gray-500 tabular-nums">
            Allocated: {formatUSD(allocation.basis.reduce((s, v) => s + v, 0))}
          </span>
        </div>
        <div className="space-y-2">
          {cards.map((c, i) => (
            <div key={i} className="border border-gray-200 rounded-lg p-3">
              <div className="grid grid-cols-[1fr_100px_100px_28px] gap-2 items-start">
                <div>
                  {c.isNew ? (
                    <input
                      type="text"
                      value={c.itemName ?? ''}
                      onChange={e => updateCard(i, { itemName: e.target.value })}
                      placeholder="New item name"
                      autoFocus
                      className={inputCls}
                      aria-label="New card item name"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPickerOpenIdx(i)}
                      className={`${inputCls} text-left`}
                      aria-label="Select item for this card"
                    >
                      {c.itemName ?? <span className="text-gray-400">Pick or create item…</span>}
                    </button>
                  )}
                </div>
                {method !== 'equal' && (
                  <input
                    type="number" min="0" step="0.01" value={c.value || ''}
                    onChange={e => updateCard(i, { value: safeNum(e.target.value) })}
                    className={inputCls}
                    placeholder={method === 'specific_id' ? 'Cost $' : 'Est. value'}
                    title={method === 'specific_id' ? 'Dollar basis for this card' : 'Relative value weight'}
                  />
                )}
                <div className={`${inputCls} tabular-nums bg-gray-50 text-gray-700 text-right border-gray-100 ${method === 'equal' ? 'col-start-2' : ''}`}>
                  {formatUSD(allocation.basis[i] ?? 0)}
                </div>
                <button
                  type="button"
                  onClick={() => setCards(prev => prev.filter((_, idx) => idx !== i))}
                  className="text-gray-400 hover:text-red-500 p-1.5"
                  disabled={cards.length === 1}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {pickerOpenIdx === i && (
                <div className="mt-2">
                  <ItemPicker
                    selectedId={c.itemId}
                    onSelect={(item) => {
                      updateCard(i, { itemId: item.id, itemName: item.name, isNew: false })
                      setPickerOpenIdx(null)
                    }}
                    onCreateNew={() => {
                      updateCard(i, { itemId: null, itemName: '', isNew: true })
                      setPickerOpenIdx(null)
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setCards(prev => [...prev, emptyCard()])}
          className="mt-2 text-xs text-blue-600 hover:underline flex items-center gap-1"
        >
          <Plus size={12} /> Add card
        </button>

        {m.isError && <div className="mt-3 text-xs text-red-600">{(m.error as Error).message}</div>}
        {validationError && !m.isError && <div className="mt-3 text-xs text-gray-500">{validationError}</div>}

        <ModalActions onCancel={handleClose} submitLabel="Open box" loading={m.isPending} disabled={!!validationError} />
      </form>
    </Modal>
  )
}

function HelpContent() {
  return (
    <div className="space-y-3 leading-relaxed">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Opening a box</h3>
        <p>
          One sealed-box purchase becomes many single-card lots. Under NIMS, the full box cost
          hits Schedule C as one Cost of Goods deduction on the open date — how it's split across
          cards only affects per-card profit, never your tax total.
        </p>
      </div>
      <div>
        <p><strong>Relative value</strong> — enter each card's est. FMV; basis is allocated in
        proportion to those values. Falls back to an equal split if everything is left at 0.</p>
      </div>
      <div>
        <p><strong>Equal split</strong> — every card gets the same share, no input needed.</p>
      </div>
      <div>
        <p><strong>Specific $</strong> — type each card's dollar basis directly; they must sum to
        the box cost.</p>
      </div>
      <div>
        <p>
          Pick an existing item per card or create one inline. Each card becomes a single-unit lot
          you can later grade (Add cost to lot) or sell like any other inventory.
        </p>
      </div>
    </div>
  )
}
