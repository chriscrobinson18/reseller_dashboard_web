import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { addLotCostAdjustment, todayStr } from '../../lib/mutations'
import { useLotLinkCandidates } from '../../lib/queries'
import { basisFromAdjustments } from '../../lib/lotCost'
import { LOT_ADJUSTMENT_TYPES, KNOWN_GRADERS } from '../../lib/lotAdjustments'
import { formatUSD, formatDate } from '../../lib/utils'
import type { InventoryLot, LotAdjustmentType } from '../../lib/types'

interface Props {
  open: boolean
  onClose: () => void
  lot: InventoryLot
  itemName: string
}

type TxnMode = 'create' | 'link'

/**
 * Capitalizes a cost — grading, shipping to the grader — into a lot's basis.
 *
 * The transaction toggle is the part that matters: the fee is a Schedule C
 * deduction exactly once. If the card charge already synced from the bank,
 * link it; posting a second row here would deduct the same payment twice.
 */
export default function AddLotCostAdjustmentModal({ open, onClose, lot, itemName }: Props) {
  const qc = useQueryClient()
  const [type, setType] = useState<LotAdjustmentType>('grading')
  const [amount, setAmount] = useState('')
  const [incurredOn, setIncurredOn] = useState(todayStr)
  const [grader, setGrader] = useState('')
  const [gradeReceived, setGradeReceived] = useState('')
  const [merchant, setMerchant] = useState('')
  const [notes, setNotes] = useState('')
  const [txnMode, setTxnMode] = useState<TxnMode>('create')
  const [linkedTxnId, setLinkedTxnId] = useState('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

  const amountNum = parseFloat(amount)
  const validAmount = !isNaN(amountNum) && amountNum > 0

  const { data: candidates = [], isLoading: loadingCandidates } =
    useLotLinkCandidates(open && txnMode === 'link')

  const filteredCandidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = q
      ? candidates.filter(t => (t.merchant ?? '').toLowerCase().includes(q))
      : candidates
    return rows.slice(0, 50)
  }, [candidates, search])

  // Live preview of where this lands — the whole point of capitalizing is that
  // the basis moves, so show it moving.
  const preview = useMemo(() => {
    const existing = (lot.lot_cost_adjustments ?? []).map(a => Number(a.amount))
    const initial = lot.initial_unit_cost ?? lot.unit_cost
    const before = basisFromAdjustments(initial, lot.quantity_purchased, existing)
    const after = basisFromAdjustments(
      initial,
      lot.quantity_purchased,
      validAmount ? [...existing, amountNum] : existing,
    )
    return { before, after }
  }, [lot, amountNum, validAmount])

  const validationError = useMemo(() => {
    if (!validAmount) return 'Enter an amount greater than 0'
    if (!incurredOn) return 'Pick the date the cost was incurred'
    if (txnMode === 'link' && !linkedTxnId) return 'Pick the transaction that paid for this'
    return null
  }, [validAmount, incurredOn, txnMode, linkedTxnId])

  const mutation = useMutation({
    mutationFn: () => addLotCostAdjustment({
      lotId: lot.id,
      adjustmentType: type,
      amount: amountNum,
      incurredOn,
      grader: type === 'grading' ? grader : null,
      gradeReceived: type === 'grading' ? gradeReceived : null,
      notes,
      transaction: txnMode === 'link'
        ? { mode: 'link', transactionId: linkedTxnId }
        : { mode: 'create', merchant },
    }),
    onSuccess: () => {
      // Touches inventory_lots, lot_cost_adjustments and possibly transactions.
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['lot-link-candidates'] })
      reset()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function reset() {
    setType('grading'); setAmount(''); setIncurredOn(todayStr()); setGrader('')
    setGradeReceived(''); setMerchant(''); setNotes(''); setTxnMode('create')
    setLinkedTxnId(''); setSearch(''); setError(null)
    mutation.reset()
  }

  function handleClose() { reset(); onClose() }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (validationError) return
    mutation.mutate()
  }

  const typeMeta = LOT_ADJUSTMENT_TYPES.find(t => t.value === type)!

  return (
    <Modal open={open} onClose={handleClose} title="Add Cost to Lot" width="max-w-xl">
      <form onSubmit={submit}>
        <p className="text-xs text-gray-500 mb-3">
          Adding cost to <span className="font-medium text-gray-700">{itemName}</span> —
          {' '}{lot.quantity_purchased} unit{lot.quantity_purchased === 1 ? '' : 's'} bought
          {' '}{formatDate(lot.purchase_date ?? lot.created_at)}.
        </p>

        {/* Type */}
        <Field label="Cost type" hint={typeMeta.hint}>
          <div className="flex gap-1.5">
            {LOT_ADJUSTMENT_TYPES.map(t => (
              <button
                key={t.value}
                type="button"
                onClick={() => setType(t.value)}
                className={`flex-1 text-xs px-2 py-1.5 rounded-lg border transition-colors ${
                  type === t.value
                    ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <input
              type="number" step="0.01" min="0" value={amount} placeholder="0.00"
              onChange={e => setAmount(e.target.value)} className={inputCls}
            />
          </Field>
          <Field label="Incurred on" hint="When the fee was paid">
            <input
              type="date" value={incurredOn}
              onChange={e => setIncurredOn(e.target.value)} className={inputCls}
            />
          </Field>
        </div>

        {type === 'grading' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Grader" hint="Optional">
              <input
                list="known-graders" value={grader} placeholder="PSA"
                onChange={e => setGrader(e.target.value)} className={inputCls}
              />
              <datalist id="known-graders">
                {KNOWN_GRADERS.map(g => <option key={g} value={g} />)}
              </datalist>
            </Field>
            <Field label="Grade received" hint="Optional — fill in when it returns">
              <input
                value={gradeReceived} placeholder="PSA 10"
                onChange={e => setGradeReceived(e.target.value)} className={inputCls}
              />
            </Field>
          </div>
        )}

        {/* Where the deduction comes from */}
        <Field
          label="Deduction"
          hint="This fee is deductible once — either it's already in your transactions, or we add it"
        >
          <div className="flex gap-1.5 mb-2">
            <button
              type="button"
              onClick={() => setTxnMode('create')}
              className={`flex-1 text-xs px-2 py-1.5 rounded-lg border transition-colors ${
                txnMode === 'create'
                  ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              Create a transaction
            </button>
            <button
              type="button"
              onClick={() => setTxnMode('link')}
              className={`flex-1 text-xs px-2 py-1.5 rounded-lg border transition-colors ${
                txnMode === 'link'
                  ? 'bg-blue-50 border-blue-300 text-blue-700 font-medium'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              Link an existing one
            </button>
          </div>
        </Field>

        {txnMode === 'create' ? (
          <Field label="Merchant" hint="Optional — defaults to the grader or cost type">
            <input
              value={merchant} placeholder="PSA"
              onChange={e => setMerchant(e.target.value)} className={inputCls}
            />
          </Field>
        ) : (
          <div className="mb-3">
            <input
              value={search} placeholder="Search transactions…"
              onChange={e => setSearch(e.target.value)} className={inputCls + ' mb-1.5'}
            />
            <div className="border border-gray-200 rounded-lg max-h-44 overflow-y-auto">
              {loadingCandidates ? (
                <div className="text-xs text-gray-400 p-3">Loading…</div>
              ) : filteredCandidates.length === 0 ? (
                <div className="text-xs text-gray-400 p-3">
                  No uncategorized or cost-of-goods expenses found.
                </div>
              ) : filteredCandidates.map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setLinkedTxnId(t.id)}
                  className={`w-full text-left px-3 py-2 text-xs border-b border-gray-100 last:border-0 flex justify-between gap-2 ${
                    linkedTxnId === t.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="truncate">
                    <span className="text-gray-800">{t.merchant ?? '—'}</span>
                    <span className="text-gray-400 ml-1.5">{formatDate(t.date)}</span>
                  </span>
                  <span className="tabular-nums text-gray-700 shrink-0">
                    {formatUSD(Math.abs(t.amount))}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <Field label="Notes" hint="Optional">
          <input value={notes} onChange={e => setNotes(e.target.value)} className={inputCls} />
        </Field>

        {validAmount && (
          <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600 space-y-1">
            <div className="flex justify-between">
              <span>Lot basis</span>
              <span className="tabular-nums">
                {formatUSD(preview.before.totalBasis)} → {' '}
                <span className="font-semibold text-gray-900">
                  {formatUSD(preview.after.totalBasis)}
                </span>
              </span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Per unit</span>
              <span className="tabular-nums">
                {formatUSD(preview.before.unitCost)} → {formatUSD(preview.after.unitCost)}
              </span>
            </div>
          </div>
        )}

        <p className="text-xs text-gray-400 mt-3">
          Capitalized into this lot's cost basis, so it shows up in profit when the
          item sells. {txnMode === 'create'
            ? 'A Cost of Goods transaction will be created for the deduction.'
            : 'No new transaction — the linked one is the deduction.'}
        </p>

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
        {validationError && !error && <div className="text-xs text-gray-500 mt-2">{validationError}</div>}

        <ModalActions
          onCancel={handleClose}
          submitLabel="Add Cost"
          loading={mutation.isPending}
          disabled={!!validationError}
        />
      </form>
    </Modal>
  )
}
