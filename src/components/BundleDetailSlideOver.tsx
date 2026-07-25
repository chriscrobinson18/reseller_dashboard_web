import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Package, TrendingUp, TrendingDown } from 'lucide-react'
import SlideOver from './SlideOver'
import ConfirmDialog from './ConfirmDialog'
import { useBundle } from '../lib/queries'
import { deleteBundleSale } from '../lib/mutations'
import { formatUSD, formatDate } from '../lib/utils'
import { paymentMethodLabel } from '../lib/paymentMethods'

interface Props {
  bundleId: string | null
  onClose: () => void
}

export default function BundleDetailSlideOver({ bundleId, onClose }: Props) {
  const qc = useQueryClient()
  const { data, isLoading } = useBundle(bundleId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const del = useMutation({
    mutationFn: () => deleteBundleSale(bundleId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['bundle'] })
      setConfirmDelete(false)
      onClose()
    },
    onError: () => setConfirmDelete(false),
  })

  if (!bundleId) return null

  return (
    <>
      <SlideOver open={!!bundleId} onClose={onClose} title="Bundle Sale" width="w-[520px]">
        {isLoading || !data ? (
          <div className="text-xs text-gray-400">Loading…</div>
        ) : (() => {
          const { bundle, lines, transactions } = data
          const lineTotal = lines.reduce((s, l) => s + l.sale_price, 0)
          const payoutTx = transactions.find(t => t.schedule_c_category === 'payout')
          const feeTx = transactions.find(t => t.schedule_c_category === 'commissions_fees')
          const shipTx = transactions.find(t => t.schedule_c_category === 'shipping_postage')
          const netTotal = transactions.reduce((s, t) => s + t.amount, 0)
          const anyOversold = lines.some(l => l.inventory_status === 'oversold')

          return (
            <div className="space-y-4">
              {/* Header */}
              <div>
                <div className="text-lg font-semibold text-gray-900">{formatDate(bundle.sold_at)}</div>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  {bundle.platform && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700 capitalize">
                      {bundle.platform}
                    </span>
                  )}
                  {paymentMethodLabel(bundle.payment_method) && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium border border-gray-200 text-gray-600">
                      {paymentMethodLabel(bundle.payment_method)}
                    </span>
                  )}
                  {bundle.external_order_id && (
                    <span className="text-xs text-gray-400">#{bundle.external_order_id}</span>
                  )}
                  {anyOversold && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
                      Oversold
                    </span>
                  )}
                </div>
              </div>

              {/* Line items */}
              <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  {lines.length} item{lines.length === 1 ? '' : 's'}
                </div>
                <div className="space-y-1.5">
                  {lines.map(l => (
                    <div key={l.id} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Package size={12} className="text-gray-400 shrink-0" />
                        <span className="truncate text-gray-800">{l.items?.name ?? '—'}</span>
                        <span className="text-gray-400 shrink-0">×{l.quantity}</span>
                        {l.inventory_status === 'oversold' && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 shrink-0">
                            Oversold
                          </span>
                        )}
                      </div>
                      <span className="tabular-nums text-gray-700 shrink-0 ml-2">{formatUSD(l.sale_price)}</span>
                    </div>
                  ))}
                </div>
                <div className="border-t border-gray-200 mt-2 pt-2 flex justify-between text-xs font-semibold text-gray-900">
                  <span>Items total</span>
                  <span className="tabular-nums">{formatUSD(lineTotal)}</span>
                </div>
              </div>

              {/* Schedule C impact */}
              <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Schedule C impact</div>
                <div className="space-y-1.5">
                  {payoutTx && (
                    <div className="flex justify-between items-center text-xs">
                      <div className="flex items-center gap-1.5 text-gray-700">
                        <TrendingUp size={12} className="text-green-600 shrink-0" />
                        <span>Payout</span>
                      </div>
                      <span className="tabular-nums text-green-700">+{formatUSD(payoutTx.amount)}</span>
                    </div>
                  )}
                  {feeTx && (
                    <div className="flex justify-between items-center text-xs">
                      <div className="flex items-center gap-1.5 text-gray-700">
                        <TrendingDown size={12} className="text-red-600 shrink-0" />
                        <span>Fees</span>
                      </div>
                      <span className="tabular-nums text-red-700">−{formatUSD(Math.abs(feeTx.amount))}</span>
                    </div>
                  )}
                  {shipTx && (
                    <div className="flex justify-between items-center text-xs">
                      <div className="flex items-center gap-1.5 text-gray-700">
                        <TrendingDown size={12} className="text-red-600 shrink-0" />
                        <span>Shipping</span>
                      </div>
                      <span className="tabular-nums text-red-700">−{formatUSD(Math.abs(shipTx.amount))}</span>
                    </div>
                  )}
                </div>
                <div className="border-t border-gray-200 my-2" />
                <div className="flex justify-between items-center text-xs font-semibold text-gray-900">
                  <span>Net payout</span>
                  <span className="tabular-nums">{formatUSD(netTotal)}</span>
                </div>
              </div>

              {bundle.notes && (
                <div>
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Notes</div>
                  <div className="text-xs text-gray-700">{bundle.notes}</div>
                </div>
              )}

              {/* Footer */}
              <div className="mt-6 pt-4 border-t border-gray-200 flex justify-end flex-col items-end gap-2">
                {del.isError && <div className="text-xs text-red-600">{(del.error as Error).message}</div>}
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                >
                  Delete bundle
                </button>
              </div>
            </div>
          )
        })()}
      </SlideOver>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete bundle sale?"
        message="This reverses every item's FIFO depletion (restoring inventory), removes the bundle's payout/fee/shipping transactions, and soft-deletes the bundle and its lines."
        confirmLabel="Delete bundle"
        loading={del.isPending}
        onCancel={() => { setConfirmDelete(false); del.reset() }}
        onConfirm={() => del.mutate()}
      />
    </>
  )
}
