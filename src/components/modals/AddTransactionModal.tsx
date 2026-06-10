import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { insertTransaction, todayStr } from '../../lib/mutations'
import { CATEGORIES } from '../../lib/categories'

export default function AddTransactionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [date, setDate] = useState(todayStr())
  const [amount, setAmount] = useState('')
  const [direction, setDirection] = useState<'expense' | 'income'>('expense')
  const [merchant, setMerchant] = useState('')
  const [category, setCategory] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => {
      const raw = parseFloat(amount)
      const signed = direction === 'expense' ? -Math.abs(raw) : Math.abs(raw)
      // Pick a transaction "type" loosely from the category for the CHECK constraint.
      const type = category === 'cost_of_goods' ? 'inventory'
        : category === 'commissions_fees' ? 'fee'
        : category === 'shipping_postage' ? 'shipping'
        : 'other'
      return insertTransaction({
        date,
        amount: signed,
        merchant: merchant.trim() || null,
        type,
        scheduleCCategory: category || null,
        notes: notes.trim() || null,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      reset()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function reset() {
    setDate(todayStr()); setAmount(''); setDirection('expense')
    setMerchant(''); setCategory(''); setNotes(''); setError(null)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const raw = parseFloat(amount)
    if (isNaN(raw) || raw <= 0) { setError('Enter a valid amount'); return }
    mutation.mutate()
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title="Add Manual Transaction">
      <form onSubmit={submit}>
        {/* Direction toggle */}
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-4">
          {(['expense', 'income'] as const).map(d => (
            <button
              key={d}
              type="button"
              onClick={() => setDirection(d)}
              className={`flex-1 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
                direction === d
                  ? d === 'expense' ? 'bg-white text-red-600 shadow-sm' : 'bg-white text-green-600 shadow-sm'
                  : 'text-gray-500'
              }`}
            >
              {d === 'expense' ? 'Money Out (Expense)' : 'Money In (Income)'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <input autoFocus type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} className={inputCls} placeholder="0.00" />
          </Field>
          <Field label="Date">
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <Field label="Merchant" hint="Optional">
          <input value={merchant} onChange={e => setMerchant(e.target.value)} className={inputCls} placeholder="e.g. USPS, Goodwill" />
        </Field>
        <Field label="Schedule C Category">
          <select value={category} onChange={e => setCategory(e.target.value)} className={inputCls + ' bg-white'}>
            <option value="">— Uncategorized</option>
            {CATEGORIES.map(c => (
              <option key={c.value} value={c.value}>
                {c.label}{c.scheduleLine ? ` (${c.scheduleLine})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes" hint="Optional">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className={inputCls + ' resize-none'} />
        </Field>

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <ModalActions onCancel={() => { reset(); onClose() }} submitLabel="Add Transaction" loading={mutation.isPending} />
      </form>
    </Modal>
  )
}
