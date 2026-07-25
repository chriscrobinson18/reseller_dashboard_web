import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Filter, ChevronDown, Plus, Pencil, Trash2, Tag, X, ExternalLink } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getPeriodRange, type PeriodPreset } from '../lib/periods'
import { resolveCategory, type CustomCategory } from '../lib/categories'
import { formatUSD, formatDate } from '../lib/utils'
import { updateTransaction, deleteTransaction } from '../lib/mutations'
import PeriodPicker from '../components/PeriodPicker'
import CategoryBadge from '../components/CategoryBadge'
import SlideOver from '../components/SlideOver'
import ConfirmDialog from '../components/ConfirmDialog'
import AddTransactionModal from '../components/modals/AddTransactionModal'
import ManageCategoriesModal from '../components/modals/ManageCategoriesModal'
import TransactionInventorySection from '../components/TransactionInventorySection'
import { Field, inputCls } from '../components/Modal'
import TradeDetailSlideOver from '../components/TradeDetailSlideOver'
import MerchantAvatar from '../components/MerchantAvatar'
import { useTrade, useCustomCategories } from '../lib/queries'
import CategoryDropdown from '../components/CategoryDropdown'
import type { Transaction } from '../lib/types'

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Flattens every user-visible detail of a transaction into one lowercase string
 * for substring matching, so the search box covers anything the row or its
 * detail panel can show — not just merchant/notes.
 *
 * Amounts appear in several shapes on purpose: `140.10` (raw), `$140.10`, and
 * `140.1`, so both "140.10" and "$140.10" hit. The sign is dropped — people
 * search the magnitude they saw on the receipt. Dates likewise appear as both
 * ISO (`2026-05-15`) and display (`May 15, 2026`) form.
 */
function transactionHaystack(t: Transaction, customs: CustomCategory[]): string {
  const abs = Math.abs(t.amount)
  const parts: (string | null | undefined)[] = [
    t.merchant,
    t.notes,
    resolveCategory(t.schedule_c_category, customs)?.label,
    t.schedule_c_category ? undefined : 'uncategorized',
    t.type,
    t.source,
    t.platform,
    t.account_display,
    t.record_type,
    // Amount, in the forms a person is likely to type.
    abs.toFixed(2),
    formatUSD(abs),
    String(abs),
    t.amount < 0 ? 'expense' : 'income',
    // Date, ISO and display.
    t.date,
    formatDate(t.date),
    // Plaid enrichment.
    t.merchant_website,
    t.location_city,
    t.location_region,
    t.payment_channel,
    t.plaid_category,
    t.plaid_category_detailed,
    t.pending ? 'pending' : null,
  ]
  return parts.filter(Boolean).join(' ').toLowerCase()
}

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

/** Assigns one category to many transactions in a single round-trip. */
async function bulkUpdateCategory(ids: string[], category: string | null) {
  if (ids.length === 0) return
  const { error } = await supabase
    .from('transactions')
    .update({ schedule_c_category: category })
    .in('id', ids)
  if (error) throw error
}

// ─── Transaction detail slide-over ───────────────────────────────────────────

function TransactionDetail({ tx, onClose, onOpenTrade, onManage }: { tx: Transaction; onClose: () => void; onOpenTrade: (id: string) => void; onManage: () => void }) {
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
  const { data: customsInDetail = [] } = useCustomCategories()
  const cat = resolveCategory(tx.schedule_c_category, customsInDetail)
  const isPlaid = tx.source === 'plaid'
  const tradeQ = useTrade(tx.trade_id ?? null)

  return (
    <div className="space-y-4">
      {tx.trade_id && (
        <div className="mb-3 p-3 rounded-lg bg-purple-50 border border-purple-200 text-xs text-purple-900">
          {tradeQ.isLoading || !tradeQ.data ? (
            <div className="text-purple-700">
              {tradeQ.isLoading ? 'Loading trade…' : 'This transaction is part of a trade. Edit or delete it from the trade.'}
              <button
                type="button"
                onClick={() => { onClose(); onOpenTrade(tx.trade_id!) }}
                className="ml-2 underline font-medium"
              >
                Open trade
              </button>
            </div>
          ) : (
            <>
              <div className="font-medium mb-2">
                Trade · {formatDate(tradeQ.data.trade.traded_at)}
                {tradeQ.data.trade.counterparty && <> · {tradeQ.data.trade.counterparty}</>}
              </div>
              <div className="mb-1">
                <span className="text-purple-600 uppercase tracking-wide text-[10px] font-semibold mr-1">You gave</span>
                {tradeQ.data.givenSales.map(s => `${s.items?.name ?? '—'} × ${s.quantity}`).join(', ') || '—'}
              </div>
              <div className="mb-2">
                <span className="text-purple-600 uppercase tracking-wide text-[10px] font-semibold mr-1">You received</span>
                {tradeQ.data.receivedLots.map(l => `${l.items?.name ?? '—'} × ${l.quantity_purchased}`).join(', ') || '—'}
              </div>
              <button
                type="button"
                onClick={() => { onClose(); onOpenTrade(tx.trade_id!) }}
                className="underline font-medium"
              >
                Open trade
              </button>
            </>
          )}
        </div>
      )}
      {/* Action buttons */}
      <div className="flex gap-2">
        {!isPlaid && (
          <button
            onClick={() => setEditing(!editing)}
            disabled={!!tx.trade_id}
            title={tx.trade_id ? 'Locked — part of a trade' : undefined}
            className="flex-1 flex items-center justify-center gap-1.5 border border-gray-200 rounded-lg py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Pencil size={13} /> {editing ? 'Cancel Edit' : 'Edit'}
          </button>
        )}
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={!!tx.trade_id}
          title={tx.trade_id ? 'Locked — part of a trade' : undefined}
          className={`${isPlaid ? 'flex-1' : ''} flex items-center justify-center gap-1.5 border border-red-200 text-red-600 rounded-lg py-2 px-3 text-sm font-medium hover:bg-red-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed`}
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
            disabled={saveMutation.isPending || !!tx.trade_id}
            title={tx.trade_id ? 'Locked — part of a trade' : undefined}
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
          <div className="flex items-center gap-3 mt-2">
            <MerchantAvatar logoUrl={tx.merchant_logo_url} merchant={tx.merchant ?? null} size={36} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                {tx.merchant_website ? (
                  <a
                    href={tx.merchant_website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-gray-900 hover:underline inline-flex items-center gap-1"
                  >
                    {tx.merchant || '—'}
                    <ExternalLink size={12} className="text-gray-400" />
                  </a>
                ) : (
                  <span className="text-sm font-medium text-gray-900">{tx.merchant || '—'}</span>
                )}
                {tx.pending && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
                    Pending
                  </span>
                )}
              </div>
              {(() => {
                const authd = tx.authorized_date
                const showDual = authd && authd !== tx.date
                return showDual ? (
                  <div className="text-xs text-gray-500 mt-0.5">
                    Purchased {formatDate(authd)} · Posted {formatDate(tx.date)}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 mt-0.5">{formatDate(tx.date)}</div>
                )
              })()}
              {tx.pending && (
                <div className="text-xs text-gray-400 mt-0.5">Will finalize within a few days.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Category */}
      <div>
        <div className="text-xs font-medium text-gray-500 mb-1.5">Schedule C Category</div>
        <div className="relative">
          <button
            onClick={() => !tx.trade_id && setEditingCat(!editingCat)}
            disabled={!!tx.trade_id}
            title={tx.trade_id ? 'Locked — part of a trade' : undefined}
            className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 text-sm w-full text-left hover:border-gray-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {cat ? (
              <CategoryBadge value={tx.schedule_c_category} />
            ) : (
              <span className="text-gray-400 text-xs">No category</span>
            )}
            {!tx.trade_id && <ChevronDown size={14} className="text-gray-400 ml-auto" />}
          </button>
          {!tx.trade_id && editingCat && (
            <div className="absolute top-full left-0 right-0 z-10 mt-1">
              <CategoryDropdown
                current={tx.schedule_c_category}
                onSelect={(v) => { catMutation.mutate(v); setEditingCat(false) }}
                onManage={() => { setEditingCat(false); onManage() }}
              />
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

      {/* Details (Plaid metadata) */}
      {(() => {
        const channelLabel: Record<string, string> = {
          'online': 'Online',
          'in store': 'In store',
          'other': 'Other',
        }
        const locParts = [
          tx.location_city,
          tx.location_region,
          tx.location_store_number ? `Store #${tx.location_store_number}` : null,
        ].filter(Boolean) as string[]
        const showCurrency = tx.iso_currency_code && tx.iso_currency_code !== 'USD'
        const hasAny = tx.payment_channel || locParts.length > 0 || showCurrency
        if (!hasAny) return null
        return (
          <div className="border-t border-gray-100 pt-3 space-y-2">
            {tx.payment_channel && (
              <div className="text-xs">
                <span className="text-gray-500 mr-2">Channel:</span>
                <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-medium">
                  {channelLabel[tx.payment_channel as string] ?? tx.payment_channel}
                </span>
              </div>
            )}
            {locParts.length > 0 && (
              <div className="text-xs">
                <span className="text-gray-500 mr-2">Location:</span>
                <span className="text-gray-700">{locParts.join(' · ')}</span>
              </div>
            )}
            {showCurrency && (
              <div className="text-xs">
                <span className="text-gray-500 mr-2">Currency:</span>
                <span className="text-gray-700">{tx.iso_currency_code}</span>
              </div>
            )}
          </div>
        )
      })()}

      {/* Plaid raw category */}
      {tx.plaid_category && (
        <div className="text-xs text-gray-400">
          Plaid category:{' '}
          <span className="text-gray-600">
            {tx.plaid_category}
            {tx.plaid_category_detailed && ` / ${tx.plaid_category_detailed}`}
          </span>
          {tx.plaid_category_confidence && (
            <span
              className={`ml-2 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                tx.plaid_category_confidence === 'VERY_HIGH' || tx.plaid_category_confidence === 'HIGH'
                  ? 'bg-green-50 text-green-700'
                  : tx.plaid_category_confidence === 'MEDIUM'
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-gray-100 text-gray-600'
              }`}
            >
              {tx.plaid_category_confidence.replace('_', ' ')}
            </span>
          )}
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
  const [openTradeId, setOpenTradeId] = useState<string | null>(null)
  const [showManage, setShowManage] = useState(false)
  const [showCatFilter, setShowCatFilter] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkCat, setShowBulkCat] = useState(false)

  const qc = useQueryClient()
  const { data: customsAll = [] } = useCustomCategories()

  const updateCategoryMutation = useMutation({
    mutationFn: ({ id, cat }: { id: string; cat: string | null }) => updateCategory(id, cat),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['transactions'] }),
  })

  const bulkCatMutation = useMutation({
    mutationFn: (cat: string | null) => bulkUpdateCategory([...selectedIds], cat),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      setSelectedIds(new Set())
      setShowBulkCat(false)
    },
  })

  const range = getPeriodRange(period)

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['transactions', range.start, range.end],
    queryFn: () => fetchTransactions(range.start, range.end),
  })

  const filtered = useMemo(() => {
    // Whitespace-separated terms must ALL match somewhere in the haystack, so
    // "ebay 140" narrows rather than widening. Currency punctuation is stripped
    // from the query so "$1,234.56" and "1234.56" behave the same.
    const terms = search
      .toLowerCase()
      .split(/\s+/)
      .map(t => t.replace(/[$,]/g, ''))
      .filter(Boolean)

    return transactions.filter(t => {
      if (!showSaleLinked && (t.related_sale_id || t.source === 'csv_import')) return false
      if (catFilter && t.schedule_c_category !== catFilter) return false
      if (terms.length > 0) {
        const hay = transactionHaystack(t, customsAll)
        if (!terms.every(term => hay.includes(term))) return false
      }
      return true
    })
  }, [transactions, showSaleLinked, catFilter, search, customsAll])

  // Trade-linked transactions have locked categories (edited via the trade),
  // so they're excluded from bulk selection.
  const selectable = useMemo(() => filtered.filter(t => !t.trade_id), [filtered])

  // Clear any selection when the visible set changes, so a bulk action never
  // silently applies to rows the user can no longer see. Render-phase reset
  // (React's "storing info from previous renders" pattern) rather than an effect.
  const filterSig = `${range.start}|${range.end}|${search}|${catFilter}|${showSaleLinked}`
  const [lastFilterSig, setLastFilterSig] = useState(filterSig)
  if (filterSig !== lastFilterSig) {
    setLastFilterSig(filterSig)
    setSelectedIds(new Set())
    setShowBulkCat(false)
  }

  const allSelected = selectable.length > 0 && selectable.every(t => selectedIds.has(t.id))
  const someSelected = selectedIds.size > 0

  function toggleRow(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(selectable.map(t => t.id)))
  }

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
      <div className="relative flex-1 flex flex-col overflow-hidden">
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
                placeholder="Search amount, merchant, category, notes…"
                className="w-full pl-8 pr-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowCatFilter(s => !s)}
                className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-700 bg-white flex items-center gap-1 min-w-[10rem]"
              >
                <span className="truncate">
                  {catFilter
                    ? (resolveCategory(catFilter, customsAll)?.label ?? catFilter)
                    : 'All categories'}
                </span>
                <ChevronDown size={12} className="ml-auto text-gray-400 shrink-0" />
              </button>
              {showCatFilter && (
                <div className="absolute right-0 top-full mt-1 z-50">
                  <CategoryDropdown
                    current={catFilter}
                    onSelect={(v) => { setCatFilter(v); setShowCatFilter(false) }}
                    onManage={() => { setShowCatFilter(false); setShowManage(true) }}
                  />
                </div>
              )}
            </div>
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
                  <th className="px-4 py-2.5 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={selectable.length === 0}
                      title="Select all"
                      className="align-middle accent-gray-900 disabled:opacity-40"
                    />
                  </th>
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
                      className={`data-row border-b border-gray-100 ${selected?.id === tx.id ? 'selected' : ''} ${selectedIds.has(tx.id) ? 'bg-gray-50' : ''}`}
                      onClick={() => setSelected(tx)}
                    >
                      <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(tx.id)}
                          onChange={() => toggleRow(tx.id)}
                          disabled={!!tx.trade_id}
                          title={tx.trade_id ? 'Locked — part of a trade' : undefined}
                          className="align-middle accent-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{tx.date}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5 font-medium text-gray-900 text-sm">
                          <span className="truncate max-w-xs">
                            {tx.merchant || <span className="text-gray-400">—</span>}
                          </span>
                          {tx.is_non_cash && (
                            <span className="inline-block px-1.5 py-0.5 text-[10px] font-medium bg-gray-200 text-gray-700 rounded shrink-0">
                              non-cash
                            </span>
                          )}
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
                          onClick={tx.trade_id ? undefined : e => openDropdown(tx.id, e)}
                        />
                        {!tx.trade_id && ddTxId === tx.id && (
                          <div
                            className="fixed z-50"
                            style={{ top: 'var(--dd-top)', left: 'var(--dd-left)' }}
                            onMouseDown={e => e.preventDefault()}
                          >
                            <CategoryDropdown
                              current={tx.schedule_c_category}
                              onSelect={(v) => {
                                updateCategoryMutation.mutate({ id: tx.id, cat: v })
                                setDdTxId(null)
                              }}
                              onManage={() => { setDdTxId(null); setShowManage(true) }}
                            />
                          </div>
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

        {/* Bulk action bar */}
        {someSelected && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40">
            <div className="flex items-center gap-3 bg-gray-900 text-white rounded-full shadow-xl pl-4 pr-2 py-2">
              <span className="text-sm font-medium whitespace-nowrap">{selectedIds.size} selected</span>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowBulkCat(s => !s)}
                  disabled={bulkCatMutation.isPending}
                  className="flex items-center gap-1.5 bg-white/10 hover:bg-white/20 rounded-full px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
                >
                  <Tag size={13} /> {bulkCatMutation.isPending ? 'Applying…' : 'Set category'}
                  <ChevronDown size={13} />
                </button>
                {showBulkCat && (
                  <div className="absolute bottom-full right-0 mb-2">
                    <CategoryDropdown
                      onSelect={(v) => bulkCatMutation.mutate(v)}
                      onManage={() => { setShowBulkCat(false); setShowManage(true) }}
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setSelectedIds(new Set()); setShowBulkCat(false) }}
                title="Clear selection"
                className="text-gray-400 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors"
              >
                <X size={15} />
              </button>
            </div>
          </div>
        )}
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
            onOpenTrade={(id) => setOpenTradeId(id)}
            onManage={() => setShowManage(true)}
          />
        )}
      </SlideOver>

      <AddTransactionModal open={showAddTx} onClose={() => setShowAddTx(false)} />
      <TradeDetailSlideOver tradeId={openTradeId} onClose={() => setOpenTradeId(null)} />
      <ManageCategoriesModal open={showManage} onClose={() => setShowManage(false)} />
    </div>
  )
}
