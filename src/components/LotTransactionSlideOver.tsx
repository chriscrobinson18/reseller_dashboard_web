import { useState, useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link2Off, Search, Check } from 'lucide-react'
import SlideOver from './SlideOver'
import CategoryBadge from './CategoryBadge'
import { inputCls } from './Modal'
import { useTransaction, useLotLinkCandidates } from '../lib/queries'
import { linkLotToPurchase, unlinkLotFromTransaction } from '../lib/mutations'
import { formatUSD, formatDate } from '../lib/utils'
import type { InventoryLot } from '../lib/types'

interface Props {
  lot: InventoryLot | null
  itemName?: string
  onClose: () => void
}

export default function LotTransactionSlideOver({ lot, itemName, onClose }: Props) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [markAsCogs, setMarkAsCogs] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const isLinked = !!lot?.transaction_id
  const { data: tx, isLoading: txLoading } = useTransaction(lot?.transaction_id)
  const { data: candidates = [], isLoading: candLoading } = useLotLinkCandidates(!!lot && !isLinked)

  function done() {
    qc.invalidateQueries({ queryKey: ['items'] })
    qc.invalidateQueries({ queryKey: ['lots-for-tx'] })
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['lot-link-candidates'] })
    reset()
    onClose()
  }

  function reset() { setSearch(''); setMarkAsCogs(true); setError(null) }

  const link = useMutation({
    mutationFn: (txId: string) => linkLotToPurchase({
      lotId: lot!.id,
      transactionId: txId,
      markAsCogs,
    }),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  })

  const unlink = useMutation({
    mutationFn: () => unlinkLotFromTransaction(lot!.id),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  })

  const filtered = useMemo(() => {
    if (!search) return candidates
    const q = search.toLowerCase()
    return candidates.filter(t => (t.merchant ?? '').toLowerCase().includes(q))
  }, [candidates, search])

  const lotTotal = lot ? lot.quantity_purchased * lot.unit_cost : 0

  return (
    <SlideOver
      open={!!lot}
      onClose={() => { reset(); onClose() }}
      title={isLinked ? 'Purchase Transaction' : 'Link Purchase Transaction'}
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

          {isLinked ? (
            txLoading || !tx ? (
              <div className="text-xs text-gray-400">Loading…</div>
            ) : (
              <>
                <div className="border border-gray-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 text-sm truncate">{tx.merchant || '—'}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{formatDate(tx.date)}</div>
                    </div>
                    <div className={`text-sm font-semibold tabular-nums shrink-0 ${tx.amount < 0 ? 'text-gray-900' : 'text-green-600'}`}>
                      {formatUSD(Math.abs(tx.amount))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <CategoryBadge value={tx.schedule_c_category} size="xs" />
                    <span className="text-xs text-gray-400 capitalize">{tx.source}</span>
                  </div>
                  {tx.notes && <div className="text-xs text-gray-600 border-t border-gray-100 pt-2">{tx.notes}</div>}
                </div>

                {Math.abs(Math.abs(tx.amount) - lotTotal) >= 0.01 && (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    This lot ({formatUSD(lotTotal)}) doesn't match the transaction total ({formatUSD(Math.abs(tx.amount))}).
                    That's expected if the purchase covers several lots.
                  </div>
                )}

                <button
                  onClick={() => unlink.mutate()}
                  disabled={unlink.isPending}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                >
                  <Link2Off size={13} /> {unlink.isPending ? 'Unlinking…' : 'Unlink transaction'}
                </button>
              </>
            )
          ) : (
            <>
              <p className="text-xs text-gray-500">
                Pick the purchase this lot came from. Showing money-out transactions that are
                uncategorized or already Cost of Goods.
              </p>

              <label className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={markAsCogs}
                  onChange={e => setMarkAsCogs(e.target.checked)}
                  className="mt-0.5 accent-gray-900"
                />
                <span className="text-xs text-amber-900">
                  Also categorize it as <strong>Cost of Goods</strong>
                  <span className="block text-amber-700 mt-0.5">
                    Inventory purchases belong in Part III. Untick to leave the category alone.
                  </span>
                </span>
              </label>

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
                    : 'No transactions match that search.'}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {filtered.map(t => {
                    const exact = Math.abs(Math.abs(t.amount) - lotTotal) < 0.01
                    return (
                      <button
                        key={t.id}
                        onClick={() => link.mutate(t.id)}
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
        </div>
      )}
    </SlideOver>
  )
}
