import { Plus, Trash2 } from 'lucide-react'
import { inputCls } from './Modal'
import { formatUSD } from '../lib/utils'
import { PAYMENT_METHODS, SPLIT_PAYMENT, type SplitRow } from '../lib/paymentMethods'

/** The Payment Method <select>, with a trailing "Split across methods…" option. */
export function PaymentMethodSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} className={inputCls + ' bg-white'}>
      <option value="">—</option>
      {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
      <option value={SPLIT_PAYMENT}>Split across methods…</option>
    </select>
  )
}

/**
 * Rows of method + amount for a split payment. Shows how much of `total` is
 * still unassigned; validation itself lives in validatePaymentSplits so the
 * modal can block submit with the same message.
 */
export function SplitPaymentEditor({ rows, onChange, total }: {
  rows: SplitRow[]
  onChange: (rows: SplitRow[]) => void
  total: number
}) {
  const assignedCents = rows.reduce((s, r) => s + Math.round((parseFloat(r.amount) || 0) * 100), 0)
  const remaining = (Math.round(total * 100) - assignedCents) / 100

  function update(i: number, patch: Partial<SplitRow>) {
    onChange(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }

  return (
    <div className="border border-gray-200 rounded-lg p-3 mb-3.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-700">Split payment</span>
        <span className={`text-xs tabular-nums ${remaining === 0 ? 'text-emerald-600' : 'text-amber-600'}`}>
          {remaining === 0 ? `Covers ${formatUSD(total)}` : `${formatUSD(Math.abs(remaining))} ${remaining > 0 ? 'unassigned' : 'over'}`}
        </span>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_110px_28px] gap-2">
            <select
              value={r.method}
              onChange={e => update(i, { method: e.target.value })}
              className={inputCls + ' bg-white'}
              aria-label={`Payment ${i + 1} method`}
            >
              <option value="">Method…</option>
              {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <input
              type="number" step="0.01" min="0" value={r.amount}
              onChange={e => update(i, { amount: e.target.value })}
              onFocus={() => {
                // Convenience: an empty last-touched row offers the remainder.
                if (!r.amount && remaining > 0) update(i, { amount: remaining.toFixed(2) })
              }}
              className={inputCls} placeholder="0.00" aria-label={`Payment ${i + 1} amount`}
            />
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              className="text-gray-400 hover:text-red-500 p-1.5 disabled:opacity-30"
              disabled={rows.length <= 2}
              title={rows.length <= 2 ? 'A split needs at least two payments' : 'Remove payment'}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, { method: '', amount: '' }])}
        className="mt-2 text-xs text-blue-600 hover:underline flex items-center gap-1"
      >
        <Plus size={12} /> Add payment
      </button>
    </div>
  )
}
