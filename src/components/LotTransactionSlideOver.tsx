import { useState, useMemo, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link2Off, Search, Check, Plus, X } from 'lucide-react'
import SlideOver from './SlideOver'
import CategoryBadge from './CategoryBadge'
import { inputCls } from './Modal'
import { useTransactionsByIds, useLotLinkCandidates } from '../lib/queries'
import {
  linkLotToPurchase,
  unlinkLotFromTransaction,
  updateLotTransactionAmount,
  setLotPurchaseDate,
} from '../lib/mutations'
import { formatUSD, formatDate } from '../lib/utils'
import type { InventoryLot, Transaction } from '../lib/types'

interface Props {
  lot: InventoryLot | null
  itemName?: string
  onClose: () => void
}

export default function LotTransactionSlideOver({ lot, itemName, onClose }: Props) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [markAsCogs, setMarkAsCogs] = useState(true)
  const [syncDate, setSyncDate] = useState(true)
  const [addingSource, setAddingSource] = useState(false)
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null)
  const [editAmount, setEditAmount] = useState('')
  const [error, setError] = useState<string | null>(null)

  const links = useMemo(
    () => [...(lot?.inventory_lot_transactions ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [lot],
  )
  const isLinked = links.length > 0
  const picking = !isLinked || addingSource

  const { data: linkedTxs = [] } = useTransactionsByIds(links.map(l => l.transaction_id))
  const { data: candidates = [], isLoading: candLoading } = useLotLinkCandidates(!!lot && picking)

  const lotTotal = lot ? lot.quantity_purchased * lot.unit_cost : 0
  const funded = links.reduce((s, l) => s + Number(l.allocated_amount), 0)
  const unfunded = lotTotal - funded
  const fullyFunded = Math.abs(unfunded) < 0.01

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['items'] })
    qc.invalidateQueries({ queryKey: ['lots-for-tx'] })
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['lot-link-candidates'] })
    qc.invalidateQueries({ queryKey: ['transactions-by-ids'] })
  }

  function reset() {
    setSearch(''); setMarkAsCogs(true); setSyncDate(true)
    setAddingSource(false); setEditingLinkId(null); setError(null)
  }

  const link = useMutation({
    mutationFn: (candidate: Transaction) => linkLotToPurchase({
      lotId: lot!.id,
      transactionId: candidate.id,
      markAsCogs,
      // Default to whatever of the lot is still unfunded, capped at what this
      // transaction can actually contribute.
      allocatedAmount: Number(
        Math.min(unfunded > 0 ? unfunded : lotTotal, Math.abs(candidate.amount)).toFixed(2),
      ),
      purchaseDate: syncDate && links.length === 0 ? candidate.date : null,
    }),
    onSuccess: () => { invalidate(); setAddingSource(false); setSearch(''); setError(null) },
    onError: (e: Error) => setError(e.message),
  })

  const saveAmount = useMutation({
    mutationFn: ({ linkId, amount }: { linkId: string; amount: number }) =>
      updateLotTransactionAmount(linkId, amount),
    onSuccess: () => { invalidate(); setEditingLinkId(null); setError(null) },
    onError: (e: Error) => setError(e.message),
  })

  const unlink = useMutation({
    mutationFn: (transactionId: string) => unlinkLotFromTransaction(lot!.id, transactionId),
    onSuccess: () => { invalidate(); setError(null) },
    onError: (e: Error) => setError(e.message),
  })

  const primaryTx = linkedTxs.find(t => t.id === links[0]?.transaction_id)
  const lotDateStr = lot ? (lot.purchase_date ?? lot.created_at).slice(0, 10) : ''
  const dateMismatch = !!primaryTx && lotDateStr !== primaryTx.date.slice(0, 10)

  const alignDate = useMutation({
    mutationFn: () => setLotPurchaseDate(lot!.id, primaryTx!.date),
    onSuccess: () => { invalidate(); setError(null) },
    onError: (e: Error) => setError(e.message),
  })

  const isAmountMatch = useCallback(
    (amount: number) => Math.abs(Math.abs(amount) - (unfunded > 0 ? unfunded : lotTotal)) < 0.01,
    [unfunded, lotTotal],
  )

  const linkedIds = new Set(links.map(l => l.transaction_id))
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    const rows = candidates
      .filter(t => !linkedIds.has(t.id))
      .filter(t => !search || (t.merchant ?? '').toLowerCase().includes(q))
    return [...rows].sort((a, b) => Number(isAmountMatch(b.amount)) - Number(isAmountMatch(a.amount)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, search, isAmountMatch, links])

  return (
    <SlideOver
      open={!!lot}
      onClose={() => { reset(); onClose() }}
      title={isLinked ? 'Purchase Funding' : 'Link Purchase Transaction'}
    >
      {!lot ? null : (
        <div className="space-y-4">
          {/* Lot context */}
          <div className="bg-gray-50 rounded-lg px-3 py-2.5">
            <div className="text-xs font-medium text-gray-900">{itemName ?? 'Lot'}</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {lot.quantity_purchased} × {formatUSD(lot.unit_cost)} = {formatUSD(lotTotal)}
              {' · '}{formatDate(lot.purchase_date ?? lot.created_at)}
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          {/* ── Funding sources ─────────────────────────────────────────── */}
          {isLinked && (
            <div className="border border-gray-200 rounded-xl p-3 space-y-2">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Funding {links.length > 1 ? `(${links.length} sources)` : ''}
              </div>

              <div className="space-y-2">
                {links.map(l => {
                  const t = linkedTxs.find(x => x.id === l.transaction_id)
                  const editing = editingLinkId === l.id
                  return (
                    <div key={l.id} className="border border-gray-100 rounded-lg px-2.5 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-gray-900 truncate">
                            {t?.merchant || (t ? '—' : 'Loading…')}
                          </div>
                          {t && (
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="text-xs text-gray-400">{formatDate(t.date)}</span>
                              <CategoryBadge value={t.schedule_c_category} size="xs" />
                              <span className="text-[10px] text-gray-400 capitalize">{t.source}</span>
                            </div>
                          )}
                          {t && (
                            <div className="text-[10px] text-gray-400 mt-0.5">
                              of {formatUSD(Math.abs(t.amount))} total
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          {editing ? (
                            <>
                              <input
                                autoFocus
                                type="number"
                                step="0.01"
                                min="0"
                                value={editAmount}
                                onChange={e => setEditAmount(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    saveAmount.mutate({ linkId: l.id, amount: parseFloat(editAmount) || 0 })
                                  }
                                  if (e.key === 'Escape') setEditingLinkId(null)
                                }}
                                className="w-20 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-right tabular-nums"
                              />
                              <button
                                onClick={() => saveAmount.mutate({ linkId: l.id, amount: parseFloat(editAmount) || 0 })}
                                className="p-1 text-green-600 hover:text-green-800"
                                title="Save amount"
                              >
                                <Check size={13} />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => { setEditingLinkId(l.id); setEditAmount(String(Number(l.allocated_amount))) }}
                              className="text-xs font-semibold tabular-nums text-gray-900 hover:underline"
                              title="Change how much of this transaction funds the lot"
                            >
                              {formatUSD(Number(l.allocated_amount))}
                            </button>
                          )}
                          <button
                            onClick={() => unlink.mutate(l.transaction_id)}
                            disabled={unlink.isPending}
                            className="p-1 text-gray-300 hover:text-red-500 disabled:opacity-50"
                            title="Remove this funding source"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="flex justify-between text-xs border-t border-gray-100 pt-1.5">
                <span className="text-gray-500">Funded of {formatUSD(lotTotal)}</span>
                <span className={`font-semibold tabular-nums ${fullyFunded ? 'text-green-600' : 'text-gray-900'}`}>
                  {formatUSD(funded)}
                </span>
              </div>

              {!fullyFunded && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  {unfunded > 0 ? (
                    <><strong>{formatUSD(unfunded)}</strong> of this lot isn't funded yet — add the other payment method.</>
                  ) : (
                    <>Funding exceeds the lot cost by <strong>{formatUSD(-unfunded)}</strong>.</>
                  )}
                </div>
              )}

              {!addingSource && (
                <button
                  onClick={() => setAddingSource(true)}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50"
                >
                  <Plus size={13} /> Add funding source
                </button>
              )}
            </div>
          )}

          {dateMismatch && primaryTx && (
            <div className="text-xs bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 flex items-start justify-between gap-3">
              <span className="text-blue-900">
                This lot is dated {formatDate(lot.purchase_date ?? lot.created_at)}, but the
                transaction is {formatDate(primaryTx.date)}. FIFO orders by the lot's date.
              </span>
              <button
                onClick={() => alignDate.mutate()}
                disabled={alignDate.isPending}
                className="shrink-0 font-medium text-blue-700 hover:text-blue-900 underline disabled:opacity-50"
              >
                {alignDate.isPending ? 'Updating…' : 'Use tx date'}
              </button>
            </div>
          )}

          {/* ── Picker ──────────────────────────────────────────────────── */}
          {picking && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  {isLinked
                    ? 'Pick the other payment method for this purchase.'
                    : 'Pick the purchase this lot came from.'}
                </p>
                {addingSource && (
                  <button
                    onClick={() => { setAddingSource(false); setSearch('') }}
                    className="text-xs text-gray-400 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                )}
              </div>

              {!isLinked && (
                <>
                  <label className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={markAsCogs}
                      onChange={e => setMarkAsCogs(e.target.checked)}
                      className="mt-0.5 accent-gray-900"
                    />
                    <span className="text-xs text-amber-900">
                      Also categorize it as <strong>Cost of Goods</strong>
                    </span>
                  </label>

                  <label className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={syncDate}
                      onChange={e => setSyncDate(e.target.checked)}
                      className="mt-0.5 accent-gray-900"
                    />
                    <span className="text-xs text-blue-900">
                      Set the lot's <strong>purchase date</strong> to the transaction's date
                    </span>
                  </label>
                </>
              )}

              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  autoFocus
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by merchant…"
                  className={inputCls + ' pl-8'}
                />
              </div>

              {candLoading ? (
                <div className="text-xs text-gray-400">Loading transactions…</div>
              ) : filtered.length === 0 ? (
                <div className="text-xs text-gray-400 bg-gray-50 rounded-lg p-3">
                  {candidates.length === 0
                    ? 'No uncategorized or Cost of Goods expenses found.'
                    : 'No other transactions match that search.'}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {filtered.map(t => {
                    const exact = isAmountMatch(t.amount)
                    return (
                      <button
                        key={t.id}
                        onClick={() => link.mutate(t)}
                        disabled={link.isPending}
                        className="w-full flex items-center gap-2 text-left bg-white border border-gray-200 rounded-lg px-3 py-2 hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-gray-900 truncate">{t.merchant || '—'}</div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-xs text-gray-400">{formatDate(t.date)}</span>
                            {t.schedule_c_category
                              ? <CategoryBadge value={t.schedule_c_category} size="xs" />
                              : <span className="text-xs text-gray-400 italic">Uncategorized</span>}
                          </div>
                        </div>
                        {exact && (
                          <span className="flex items-center gap-0.5 text-xs text-green-700 bg-green-100 px-1.5 py-0.5 rounded shrink-0">
                            <Check size={10} /> match
                          </span>
                        )}
                        <div className="text-xs font-medium tabular-nums text-gray-700 shrink-0">
                          {formatUSD(Math.abs(t.amount))}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {isLinked && !addingSource && (
            <button
              onClick={() => unlink.mutate(links[0].transaction_id)}
              disabled={unlink.isPending || links.length !== 1}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-40"
              title={links.length !== 1 ? 'Remove sources individually above' : undefined}
            >
              <Link2Off size={13} /> {unlink.isPending ? 'Unlinking…' : 'Unlink transaction'}
            </button>
          )}
        </div>
      )}
    </SlideOver>
  )
}
