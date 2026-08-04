import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Package, TrendingDown } from 'lucide-react'
import SlideOver from './SlideOver'
import ConfirmDialog from './ConfirmDialog'
import { useBoxOpening } from '../lib/queries'
import { deleteBoxOpening } from '../lib/mutations'
import { formatUSD, formatDate } from '../lib/utils'

const METHOD_LABELS: Record<string, string> = {
  relative_fmv: 'Relative value',
  equal: 'Equal split',
  specific_id: 'Specific $',
}

interface Props {
  boxOpeningId: string | null
  onClose: () => void
}

export default function BoxOpeningDetailSlideOver({ boxOpeningId, onClose }: Props) {
  const qc = useQueryClient()
  const { data, isLoading } = useBoxOpening(boxOpeningId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const del = useMutation({
    mutationFn: () => deleteBoxOpening(boxOpeningId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['box-opening'] })
      setConfirmDelete(false)
      onClose()
    },
    onError: () => setConfirmDelete(false),
  })

  if (!boxOpeningId) return null

  return (
    <>
      <SlideOver open={!!boxOpeningId} onClose={onClose} title="Breakdown" width="w-[480px]">
        {isLoading || !data ? (
          <div className="text-xs text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-lg font-semibold text-gray-900">{data.opening.box_name}</div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span className="text-sm text-gray-600">{formatDate(data.opening.opened_at)}</span>
                <span className="text-gray-300 text-sm">·</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700">
                  {METHOD_LABELS[data.opening.allocation_method] ?? data.opening.allocation_method}
                </span>
              </div>
            </div>

            <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Cost</div>
              <div className="text-base font-semibold text-gray-900 tabular-nums">
                {formatUSD(data.opening.box_cost)}
              </div>
              {data.sourceLot && (
                <div className="text-xs text-gray-500 mt-1">
                  {data.opening.quantity} × {formatUSD(data.sourceLot.unit_cost)} from{' '}
                  <span className="text-gray-700">{data.sourceLot.items?.name ?? '—'}</span>
                  {' '}({data.sourceLot.quantity_remaining} still in stock)
                </div>
              )}
            </div>

            <div>
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                Cards ({data.cards.length})
              </div>
              <div className="space-y-0.5">
                {data.cards.map(c => (
                  <div key={c.id} className="text-xs text-gray-700 flex justify-between items-center gap-2 py-1 border-b border-gray-50 last:border-0">
                    <span className="flex items-center gap-1.5 truncate">
                      <Package size={11} className="text-gray-400 shrink-0" />
                      <span className="truncate">{c.items?.name ?? '—'}</span>
                      {c.quantity_remaining === 0 && (
                        <span className="text-[10px] text-gray-400 shrink-0">sold</span>
                      )}
                    </span>
                    <span className="tabular-nums text-gray-500 shrink-0">{formatUSD(c.unit_cost)}</span>
                  </div>
                ))}
              </div>
            </div>

            {data.transaction && (
              <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Already deducted at purchase — no new Schedule C entry
                </div>
                <div className="flex justify-between items-center text-xs">
                  <div className="flex items-center gap-1.5 text-gray-700">
                    <TrendingDown size={12} className="text-gray-400 shrink-0" />
                    <span>Cost of Goods · {formatDate(data.transaction.date)}</span>
                  </div>
                  <span className="tabular-nums text-gray-500">
                    −{formatUSD(Math.abs(data.transaction.amount))}
                  </span>
                </div>
              </div>
            )}

            {data.opening.notes && (
              <div>
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Notes</div>
                <div className="text-xs text-gray-700">{data.opening.notes}</div>
              </div>
            )}

            <div className="mt-6 pt-4 border-t border-gray-200 flex justify-end flex-col items-end gap-2">
              {del.isError && <div className="text-xs text-red-600">{(del.error as Error).message}</div>}
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                Delete breakdown
              </button>
            </div>
          </div>
        )}
      </SlideOver>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete breakdown?"
        message="Removes the resulting card lots and restores the broken-down quantity back onto the source lot. Blocked if any card has already been sold — delete those sales first."
        confirmLabel="Delete breakdown"
        loading={del.isPending}
        onCancel={() => { setConfirmDelete(false); del.reset() }}
        onConfirm={() => del.mutate()}
      />
    </>
  )
}
