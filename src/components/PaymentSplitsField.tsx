import { Plus, Trash2 } from 'lucide-react'
import { Field, inputCls } from './Modal'
import { PAYMENT_METHODS, emptyPaymentSplitRow, paymentSplitsRemaining, type PaymentSplitRow } from '../lib/paymentMethods'
import { formatUSD } from '../lib/utils'

/**
 * Payment-method entry for a sale. Non-manual platforms (eBay, Amazon, ...)
 * show one plain select, same as before this feature existed — a marketplace
 * payout always settles as a single payment. Manual sales unlock split-tender
 * entry: click "Split payment" to turn the single row into two-or-more
 * method+amount rows, e.g. $300 cash + $100 PayPal for one $400 sale.
 */
export default function PaymentSplitsField({
  platform, total, rows, onChange,
}: {
  platform: string
  total: number
  rows: PaymentSplitRow[]
  onChange: (rows: PaymentSplitRow[]) => void
}) {
  const isManual = platform === 'manual'
  const isSplit = isManual && rows.length > 1
  const remaining = paymentSplitsRemaining(rows, total)

  function updateRow(i: number, patch: Partial<PaymentSplitRow>) {
    onChange(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }

  if (!isManual) {
    return (
      <Field label="Payment Method" hint="Optional">
        <select
          value={rows[0]?.method ?? ''}
          onChange={e => onChange([{ method: e.target.value, amount: '' }])}
          className={inputCls + ' bg-white'}
        >
          <option value="">—</option>
          {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </Field>
    )
  }

  return (
    <div className="col-span-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-700">Payment Method{isSplit ? 's' : ''}</span>
        {isSplit && (
          <span className={`text-[11px] tabular-nums ${Math.abs(remaining) < 0.005 ? 'text-gray-400' : 'text-amber-600'}`}>
            Remaining: {formatUSD(remaining)}
          </span>
        )}
      </div>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2">
            <select
              value={r.method}
              onChange={e => updateRow(i, { method: e.target.value })}
              className={inputCls + ' bg-white flex-1'}
            >
              <option value="">—</option>
              {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            {rows.length > 1 && (
              <>
                <input
                  type="number" step="0.01" min="0" value={r.amount} placeholder="0.00" title="Amount"
                  onChange={e => updateRow(i, { amount: e.target.value })}
                  className={inputCls + ' w-24'}
                />
                <button
                  type="button"
                  onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  className="text-gray-400 hover:text-red-500 p-1.5"
                  title="Remove payment method"
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange(rows.length === 1
          ? [{ ...rows[0], amount: rows[0].amount || (total ? String(total) : '') }, emptyPaymentSplitRow()]
          : [...rows, emptyPaymentSplitRow()])}
        className="mt-1.5 text-xs text-blue-600 hover:underline flex items-center gap-1"
      >
        <Plus size={12} /> Split payment
      </button>
    </div>
  )
}
