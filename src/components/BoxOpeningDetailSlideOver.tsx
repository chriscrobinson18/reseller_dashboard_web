import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Package, TrendingDown } from 'lucide-react'
import SlideOver from './SlideOver'
import ConfirmDialog from './ConfirmDialog'
import AddPullModal from './modals/AddPullModal'
import { useBoxOpening } from '../lib/queries'
import { deleteBoxOpening, closeBoxOpening } from '../lib/mutations'
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
  const [confirmClose, setConfirmClose] = useState(false)
  const [showAddPull, setShowAddPull] = useState(false)
  const [newLotId, setNewLotId] = useState<string | null>(null)

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

  const close = useMutation({
    mutationFn: () => closeBoxOpening(boxOpeningId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['box-opening'] })
      setConfirmClose(false)
    },
    onError: () => setConfirmClose(false),
  })

  if (!boxOpeningId) return null

  const isOpen = data?.opening.status === 'open'
  const remainingBasis = data?.remainingBasis ?? 0

  return (
    <>
      <SlideOver open={!!boxOpeningId} onClose={onClose} title="Breakdown" width="w-[480px]">
        {isLoading || !data ? (
          <div className="text-xs text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-4">
            {/* Header */}
            <div>
              <div className="text-lg font-semibold text-gray-900">{data.opening.box_name}</div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span className="text-sm text-gray-600">{formatDate(data.opening.opened_at)}</span>
                {isOpen && (
                  <>
                    <span className="text-gray-300 text-sm">·</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
                      In Progress
                    </span>
                  </>
                )}
                {data.opening.allocation_method && (
                  <>
                    <span className="text-gray-300 text-sm">·</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700">
                      {METHOD_LABELS[data.opening.allocation_method] ?? data.opening.allocation_method}
                    </span>
                  </>
                )}
                {!data.opening.allocation_method && !isOpen && (
                  <>
                    <span className="text-gray-300 text-sm">·</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700">
                      Lazy (per-card)
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Cost + pool balance */}
            <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
              <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Cost</div>
              <div className="text-base font-semibold text-gray-900 tabular-nums">
                {data.opening.box_cost !== null ? formatUSD(data.opening.box_cost) : '—'}
              </div>
              {data.sourceLot && (
                <div className="text-xs text-gray-500 mt-1">
                  {data.opening.quantity} × {formatUSD(data.sourceLot.unit_cost)} from{' '}
                  <span className="text-gray-700">{data.sourceLot.items?.name ?? '—'}</span>
                  {' '}({data.sourceLot.quantity_remaining} still in stock)
                </div>
              )}
              {isOpen && data.opening.box_cost !== null && (
                <div className="mt-2 pt-2 border-t border-gray-200 text-xs text-gray-600 tabular-nums">
                  Pool remaining:{' '}
                  <span className={remainingBasis < 0.01 ? 'text-green-600 font-medium' : 'font-medium text-gray-900'}>
                    {formatUSD(remainingBasis)}
                  </span>
                  {' '}of {formatUSD(data.opening.box_cost)}
                </div>
              )}
            </div>

            {/* Cards list */}
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
                      {c.id === newLotId && c.quantity_remaining > 0 && (
                        <span className="text-[10px] text-blue-500 shrink-0">← just added</span>
                      )}
                    </span>
                    <span className="tabular-nums text-gray-500 shrink-0">{formatUSD(c.unit_cost)}</span>
                  </div>
                ))}
                {data.cards.length === 0 && (
                  <div className="text-xs text-gray-400 italic">No pulls yet — add one below.</div>
                )}
              </div>
            </div>

            {/* Transaction panel */}
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

            {/* Notes */}
            {data.opening.notes && (
              <div>
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Notes</div>
                <div className="text-xs text-gray-700">{data.opening.notes}</div>
              </div>
            )}

            {/* Footer actions */}
            <div className="mt-6 pt-4 border-t border-gray-200 space-y-2">
              {(del.isError || close.isError) && (
                <div className="text-xs text-red-600">
                  {((del.error ?? close.error) as Error).message}
                </div>
              )}

              {isOpen && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddPull(true)}
                    className="flex-1 px-3 py-2 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Add Pull
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClose(true)}
                    disabled={close.isPending}
                    className="flex-1 px-3 py-2 text-xs font-medium border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50 transition-colors disabled:opacity-50"
                  >
                    Close Box
                  </button>
                </div>
              )}

              {!isOpen && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    Delete breakdown
                  </button>
                </div>
              )}
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

      <ConfirmDialog
        open={confirmClose}
        title="Close this box?"
        message={
          remainingBasis > 0.005
            ? `Write off ${formatUSD(remainingBasis)} to COGS and close this box. This records the remaining basis as a bulk disposal on Schedule C.`
            : 'All basis has been allocated to pulls. Close this box?'
        }
        confirmLabel="Close box"
        loading={close.isPending}
        onCancel={() => { setConfirmClose(false); close.reset() }}
        onConfirm={() => close.mutate()}
      />

      {data && (
        <AddPullModal
          open={showAddPull}
          onClose={() => setShowAddPull(false)}
          boxOpeningId={boxOpeningId!}
          remainingBasis={data.remainingBasis}
          onPullAdded={lotId => setNewLotId(lotId)}
        />
      )}
    </>
  )
}
