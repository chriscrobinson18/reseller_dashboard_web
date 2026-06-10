import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Filter, ChevronDown, Plus, Pencil, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getPeriodRange, type PeriodPreset } from '../lib/periods'
import { CATEGORIES, getCategoryDef } from '../lib/categories'
import { formatUSD, formatDate } from '../lib/utils'
import { updateTransaction, deleteTransaction } from '../lib/mutations'
import PeriodPicker from '../components/PeriodPicker'
import CategoryBadge from '../components/CategoryBadge'
import SlideOver from '../components/SlideOver'
import ConfirmDialog from '../components/ConfirmDialog'
import AddTransactionModal from '../components/modals/AddTransactionModal'
import TransactionInventorySection from '../components/TransactionInventorySection'
import { Field, inputCls } from '../components/Modal'
import type { Transaction } from '../lib/types'

// ─── Data ────────────────────────────────────────────────────────────────────

async function fetchTransactions(start: string | null, end: string | null): Promise<Transaction[]> {
  let q = supabase
    .from('transactions')
    .select('*')
    .order('date', { ascending: false })
  if (start) q = q.gte('date', start)
  if (end) q = q.lte('date', end)
  const { data, error } = await q.limit(5000)
  if (error) throw error
  return data ?? []
}

async function updateCategory(id: string, category: string | null) {
  const { error } = await supabase
    .from('transactions')
    .update({ schedule_c_category: category })
    .eq('id', id)
  if (error) throw error
}

async function updateNotes(id: string, notes: string) {
  const { error } = await supabase
    .from('transactions')
    .update({ notes })
    .eq('id', id)
  if (error) throw error
}

// ─── Category picker dropdown ─────────────────────────────────────────────────

function CategoryDropdown({ txId, current, onClose }: { txId: string; current?: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ id, cat }: { id: string; cat: string | null }) => updateCategory(id, cat),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transactions'] }); onClose() },
  })

  return (
    <div
      className="fixed z-50 bg-white border border-gray-200 rounded-xl shadow-xl py-1 overflow-y-auto max-h-72 w-56"
      style={{ top: 'var(--dd-top)', left: 'var(--dd-left)' }}
      onMouseDown={e => e.preventDefault()}
    >
      <div
        className="px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-50 cursor-pointer"
        onClick={() => mutation.mutate({ id: txId, cat: null })}
      >
        — Clear category
      </div>
      {CATEGORIES.map(c => (
        <div
          key={c.value}
          className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-gray-50 flex items-center gap-2 ${current === c.value ? 'bg-gray-50 font-medium' : ''}`}
          onClick={() => mutation.mutate({ id: txId, cat: c.value })}
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
          <span className="text-gray-700">{c.label}</span>
          {c.scheduleLine && <span className="text-gray-400 ml-auto">{c.scheduleLine}</span>}
        </div>
      ))}
    </div>
  )
}

// ─── Transaction detail slide-over ───────────────────────────────────────────

function TransactionDetail({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const qc = useQueryClient()
  const [notes, setNotes] = useState(tx.notes ?? '')
  const [editingCat, setEditingCat] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Editable fields
  const [eDate, setEDate] = useState(tx.date)
  const [eAmount, setEAmount] = useState(String(Math.abs(tx.amount)))
  const [eDirection, setEDirection] = useState<'expense' | 'income'>(tx.amount < 0 ? 'expense' : 'income')
  const [eMerchant, setEMerchant] = useState(tx.merchant ?? '')

  const catMutation = useMutation({
    mutationFn: (cat: string | null) => updateCategory(tx.id, cat),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
  })

  const notesMutation = useMutation({
    mutationFn: (n: string) => updateNotes(tx.id, n),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
  })

  const saveMutation = useMutation({
    mutationFn: () => {
      const raw = parseFloat(eAmount)
      const signed = eDirection === 'expense' ? -Math.abs(raw) : Math.abs(raw)
      return updateTransaction({
        id: tx.id,
        date: eDate,
        amount: signed,
        merchant: eMerchant.trim() || null,
        type: tx.type ?? 'other',
        scheduleCCategory: tx.schedule_c_category ?? null,
        notes: tx.notes ?? null,
      })
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transactions'] }); setEditing(false) },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteTransaction(tx.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transactions'] }); onClose() },
  })

  const isExpense = tx.amount < 0
  const cat = getCategoryDef(tx.schedule_c_category)
  const isPlaid = tx.source === 'plaid'

  return (
    <div className="space-y-4">
      {/* Action buttons */}
      <div className="flex gap-2">
        {!isPlaid && (
          <button
            onClick={() => setEditing(!editing)}
            className="flex-1 flex items-center justify-center gap-1.5 border border-gray-200 rounded-lg py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Pencil size={13} /> {editing ? 'Cancel Edit' : 'Edit'}
          </button>
        )}
        <button
          onClick={() => setConfirmDelete(true)}
          className={`${isPlaid ? 'flex-1' : ''} flex items-center justify-center gap-1.5 border border-red-200 text-red-600 rounded-lg py-2 px-3 text-sm font-medium hover:bg-red-50 transition-colors`}
        >
          <Trash2 size={13} /> Delete
        </button>
      </div>

      {isPlaid && (
        <p className="text-xs text-gray-400">
          Bank-synced transaction — fields are read-only (editable: category &amp; notes). Deleting removes it locally.
        </p>
      )}

      {/* Amount + merchant — editable when in edit mode */}
      {editing ? (
        <div className="bg-gray-50 rounded-xl p-4 space-y-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {(['expense', 'income'] as const).map(d => (
              <button
                key={d}
                type="button"
                onClick={() => setEDirection(d)}
                className={`flex-1 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                  eDirection === d
                    ? d === 'expense' ? 'bg-white text-red-600 shadow-sm' : 'bg-white text-green-600 shadow-sm'
                    : 'text-gray-500'
                }`}
              >
                {d === 'expense' ? 'Money Out' : 'Money In'}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Amount">
              <input type="number" step="0.01" min="0" value={eAmount} onChange={e => setEAmount(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Date">
              <input type="date" value={eDate} onChange={e => setEDate(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <Field label="Merchant">
            <input value={eMerchant} onChange={e => setEMerchant(e.target.value)} className={inputCls} />
          </Field>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="w-full bg-gray-900 text-white rounded-lg py-2 text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      ) : (
        <div className="bg-gray-50 rounded-xl p-4">
          <div className={`text-2xl font-bold tabular-nums ${isExpense ? 'text-red-500' : 'text-green-600'}`}>
            {isExpense ? '-' : '+'}{formatUSD(Math.abs(tx.amount))}
          </div>
          <div className="text-sm font-medium text-gray-900 mt-1">{tx.merchant || '—'}</div>
          <div className="text-xs text-gray-500 mt-0.5">{formatDate(tx.date)}</div>
        </div>
      )}

      {/* Category */}
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1.5">Schedule C Category</div>
        <div className="relative">
          <button
            onClick={() => setEditingCat(!editingCat)}
            className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 text-sm w-full text-left hover:border-gray-300 transition-colors"
          >
            {cat ? (
              <CategoryBadge value={tx.schedule_c_category} />
            ) : (
              <span className="text-gray-400 text-xs">No category</span>
            )}
            <ChevronDown size={14} className="text-gray-400 ml-auto" />
          </button>
          {editingCat && (
            <div className="absolute top-full left-0 right-0 z-10 bg-white border border-gray-200 rounded-xl shadow-xl mt-1 py-1 overflow-y-auto max-h-56">
              <div
                className="px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-50 cursor-pointer"
                onClick={() => { catMutation.mutate(null); setEditingCat(false) }}
              >
                — Clear category
              </div>
              {CATEGORIES.map(c => (
                <div
                  key={c.value}
                  className="px-3 py-1.5 text-xs cursor-pointer hover:bg-gray-50 flex items-center gap-2"
                  onClick={() => { catMutation.mutate(c.value); setEditingCat(false) }}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                  <span className="text-gray-700">{c.label}</span>
                  {c.scheduleLine && <span className="text-gray-400 ml-auto">{c.scheduleLine}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        {[
          { label: 'Source', value: tx.source },
          { label: 'Account', value: tx.account_display || '—' },
          { label: 'Platform', value: tx.platform || '—' },
          { label: 'Type', value: tx.record_type },
        ].map(({ label, value }) => (
          <div key={label} className="bg-gray-50 rounded-lg p-2.5">
            <div className="text-gray-400 mb-0.5">{label}</div>
            <div className="text-gray-800 font-medium capitalize">{value}</div>
          </div>
        ))}
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-2">
        {tx.record_type === 'settlement' && (
          <span className="px-2 py-0.5 bg-violet-100 text-violet-700 rounded text-xs font-medium">Settlement</span>
        )}
        {tx.net_zero_pair_id && (
          <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs font-medium">Net Zero Pair</span>
        )}
        {(tx.related_sale_id || tx.source === 'csv_import') && (
          <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-xs font-medium">Sale Linked</span>
        )}
      </div>

      {/* Notes */}
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1.5">Notes</div>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onBlur={() => { if (notes !== (tx.notes ?? '')) notesMutation.mutate(notes) }}
          rows={3}
          placeholder="Add notes…"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 resize-none focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        {notesMutation.isPending && <div className="text-xs text-gray-400 mt-0.5">Saving…</div>}
      </div>

      {/* Plaid raw category */}
      {tx.plaid_category && (
        <div className="text-xs text-gray-400">
          Plaid category: <span className="text-gray-600">{tx.plaid_category}</span>
        </div>
      )}

      {/* Cost of Goods → inventory linking */}
      {tx.schedule_c_category === 'cost_of_goods' && (
        <TransactionInventorySection
          transactionId={tx.id}
          transactionTotal={Math.abs(tx.amount)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete transaction?"
        message="This permanently removes the transaction. Any inventory lots linked to it will be unlinked but kept."
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const [period, setPeriod] = useState<PeriodPreset>('ytd')
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState<string | null>(null)
  const [showSaleLinked, setShowSaleLinked] = useState(false)
  const [selected, setSelected] = useState<Transaction | null>(null)
  const [ddTxId, setDdTxId] = useState<string | null>(null)
  const [showAddTx, setShowAddTx] = useState(false)

  const range = getPeriodRange(period)

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['transactions', range.start, range.end],
    queryFn: () => fetchTransactions(range.start, range.end),
  })

  const filtered = useMemo(() => {
    return transactions.filter(t => {
      if (!showSaleLinked && (t.related_sale_id || t.source === 'csv_import')) return false
      if (catFilter && t.schedule_c_category !== catFilter) return false
      if (search) {
        const q = search.toLowerCase()
        const m = (t.merchant ?? '').toLowerCase()
        const n = (t.notes ?? '').toLowerCase()
        if (!m.includes(q) && !n.includes(q)) return false
      }
      return true
    })
  }, [transactions, showSaleLinked, catFilter, search])

  const income = filtered.filter(t => t.amount > 0 && t.record_type !== 'settlement').reduce((s, t) => s + t.amount, 0)
  const expenses = filtered.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0)
  const uncategorized = transactions.filter(t =>
    !t.schedule_c_category &&
    t.record_type !== 'settlement' &&
    !t.related_sale_id &&
    t.source !== 'csv_import'
  ).length

  function openDropdown(txId: string, e: React.MouseEvent) {
    e.stopPropagation()
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    document.documentElement.style.setProperty('--dd-top', `${rect.bottom + window.scrollY + 4}px`)
    document.documentElement.style.setProperty('--dd-left', `${rect.left}px`)
    setDdTxId(txId === ddTxId ? null : txId)
  }

  return (
    <div className="flex h-full">
      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-6 border-b border-gray-200 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold text-gray-900">Expenses</h1>
            <div className="flex items-center gap-3 text-sm text-gray-500">
              {uncategorized > 0 && (
                <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full text-xs font-medium">
                  {uncategorized} uncategorized
                </span>
              )}
              <span className="text-green-600 font-medium">{formatUSD(income)} in</span>
              <span className="text-red-500 font-medium">{formatUSD(expenses)} out</span>
            </div>
          </div>
          <PeriodPicker value={period} onChange={setPeriod} />
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search merchant or notes…"
                className="w-full pl-8 pr-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
            <select
              value={catFilter ?? ''}
              onChange={e => setCatFilter(e.target.value || null)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 bg-white"
            >
              <option value="">All Categories</option>
              {CATEGORIES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <button
              onClick={() => setShowSaleLinked(!showSaleLinked)}
              className={`flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                showSaleLinked ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-400'
              }`}
            >
              <Filter size={12} /> Sale rows
            </button>
            <button
              onClick={() => setShowAddTx(true)}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-gray-700 transition-colors whitespace-nowrap"
            >
              <Plus size={13} /> Add
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto" onClick={() => setDdTxId(null)}>
          {isLoading ? (
            <div className="p-8 text-center text-gray-400 text-sm">Loading transactions…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">No transactions found.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-24">Date</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Merchant / Notes</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-44">Category</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-28">Account</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500 w-28">Amount</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(tx => {
                  const isExpense = tx.amount < 0
                  const isSettlement = tx.record_type === 'settlement'
                  return (
                    <tr
                      key={tx.id}
                      className={`data-row border-b border-gray-100 ${selected?.id === tx.id ? 'selected' : ''}`}
                      onClick={() => setSelected(tx)}
                    >
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{tx.date}</td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-gray-900 text-sm truncate max-w-xs">
                          {tx.merchant || <span className="text-gray-400">—</span>}
                        </div>
                        {tx.notes && (
                          <div className="text-xs text-gray-400 truncate max-w-xs">{tx.notes}</div>
                        )}
                        {isSettlement && (
                          <span className="text-xs text-violet-600 font-medium">Settlement</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                        <CategoryBadge
                          value={tx.schedule_c_category}
                          onClick={e => openDropdown(tx.id, e)}
                        />
                        {ddTxId === tx.id && (
                          <CategoryDropdown
                            txId={tx.id}
                            current={tx.schedule_c_category}
                            onClose={() => setDdTxId(null)}
                          />
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500 truncate max-w-[7rem]">
                        {tx.account_display || tx.platform || '—'}
                      </td>
                      <td className={`px-4 py-2.5 text-sm font-medium tabular-nums text-right ${
                        isExpense ? 'text-red-500' : 'text-green-600'
                      }`}>
                        {isExpense ? '-' : '+'}{formatUSD(Math.abs(tx.amount))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
          {filtered.length} transactions
        </div>
      </div>

      {/* Detail panel */}
      <SlideOver
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Transaction Detail"
      >
        {selected && (
          <TransactionDetail
            key={selected.id}
            tx={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </SlideOver>

      <AddTransactionModal open={showAddTx} onClose={() => setShowAddTx(false)} />
    </div>
  )
}
