import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Info, TrendingUp, TrendingDown, DollarSign } from 'lucide-react'
import SlideOver from './SlideOver'
import ConfirmDialog from './ConfirmDialog'
import { useTrade } from '../lib/queries'
import { deleteTrade } from '../lib/mutations'
import { formatUSD, formatDate } from '../lib/utils'

interface Props {
  tradeId: string | null
  onClose: () => void
}

export default function TradeDetailSlideOver({ tradeId, onClose }: Props) {
  const qc = useQueryClient()
  const { data, isLoading } = useTrade(tradeId)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const del = useMutation({
    mutationFn: () => deleteTrade(tradeId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['trade'] })
      setConfirmDelete(false)
      onClose()
    },
    onError: () => {
      setConfirmDelete(false)
    },
  })

  if (!tradeId) return null

  return (
    <>
      <SlideOver open={!!tradeId} onClose={onClose} title="Trade" width="w-[520px]">
        {isLoading || !data ? (
          <div className="text-xs text-gray-400">Loading…</div>
        ) : (() => {
          const cashBoot = data.trade.cash_boot ?? 0

          let typePill: React.ReactNode
          if (cashBoot === 0) {
            typePill = <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700">Pure swap</span>
          } else if (cashBoot > 0) {
            typePill = <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">Received boot {formatUSD(cashBoot)}</span>
          } else {
            typePill = <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-700">Paid boot {formatUSD(Math.abs(cashBoot))}</span>
          }

          const incomeAmt = data.incomeTransaction?.amount ?? 0
          const cogsAmt = data.cogsTransaction?.amount ?? 0
          const cashAmt = data.cashTransaction?.amount ?? 0
          const netAmt = incomeAmt + cogsAmt + cashAmt

          return (
            <div className="space-y-4">
              {/* Header */}
              <div>
                <div className="text-lg font-semibold text-gray-900">{formatDate(data.trade.traded_at)}</div>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  {data.trade.counterparty && (
                    <>
                      <span className="text-sm text-gray-600">{data.trade.counterparty}</span>
                      <span className="text-gray-300 text-sm">·</span>
                    </>
                  )}
                  {typePill}
                </div>
                {data.trade.fmv_source_notes && (
                  <div className="flex items-center gap-1 mt-1.5 text-xs text-gray-500">
                    <Info size={12} />
                    <span className="italic">{data.trade.fmv_source_notes}</span>
                  </div>
                )}
              </div>

              {/* Gave / Received cards */}
              <div className="grid grid-cols-2 gap-3">
                <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">You gave</div>
                  <div className="text-base font-semibold text-gray-900 mb-2 tabular-nums">{formatUSD(data.trade.given_fmv)}</div>
                  <div className="space-y-0.5">
                    {data.givenSales.map(s => (
                      <div key={s.id} className="text-xs text-gray-700 flex justify-between">
                        <span className="truncate">{s.items?.name ?? '—'}</span>
                        <span className="tabular-nums text-gray-500 ml-2">×{s.quantity}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">You received</div>
                  <div className="text-base font-semibold text-gray-900 mb-2 tabular-nums">{formatUSD(data.trade.received_fmv)}</div>
                  <div className="space-y-0.5">
                    {data.receivedLots.map(l => (
                      <div key={l.id} className="text-xs text-gray-700 flex justify-between">
                        <span className="truncate">{l.items?.name ?? '—'}</span>
                        <span className="tabular-nums text-gray-500 ml-2">×{l.quantity_purchased}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Schedule C impact */}
              <div className="p-3 rounded-lg bg-gray-50 border border-gray-200">
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Schedule C impact</div>
                <div className="space-y-1.5">
                  {data.incomeTransaction && (
                    <div className="flex justify-between items-center text-xs">
                      <div className="flex items-center gap-1.5 text-gray-700">
                        <TrendingUp size={12} className="text-green-600 shrink-0" />
                        <span>Income (non-cash)</span>
                      </div>
                      <span className="tabular-nums text-green-700">+{formatUSD(data.incomeTransaction.amount)}</span>
                    </div>
                  )}
                  {data.cogsTransaction && (
                    <div className="flex justify-between items-center text-xs">
                      <div className="flex items-center gap-1.5 text-gray-700">
                        <TrendingDown size={12} className="text-red-600 shrink-0" />
                        <span>COGS (non-cash)</span>
                      </div>
                      <span className="tabular-nums text-red-700">−{formatUSD(Math.abs(data.cogsTransaction.amount))}</span>
                    </div>
                  )}
                  {data.cashTransaction && (
                    <div className="flex justify-between items-center text-xs">
                      <div className="flex items-center gap-1.5 text-gray-700">
                        <DollarSign size={12} className="shrink-0" />
                        <span>Cash boot</span>
                      </div>
                      <span className={`tabular-nums ${cashAmt >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                        {cashAmt >= 0 ? '+' : '−'}{formatUSD(Math.abs(cashAmt))}
                      </span>
                    </div>
                  )}
                </div>
                <div className="border-t border-gray-200 my-2" />
                <div className="flex justify-between items-center text-xs font-semibold text-gray-900">
                  <span>Net at trade date</span>
                  <span className="tabular-nums">{netAmt >= 0 ? '+' : '−'}{formatUSD(Math.abs(netAmt))}</span>
                </div>
              </div>

              {/* Notes */}
              {data.trade.notes && (
                <div>
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Notes</div>
                  <div className="text-xs text-gray-700">{data.trade.notes}</div>
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
                  Delete trade
                </button>
              </div>
            </div>
          )
        })()}
      </SlideOver>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete trade?"
        message="This reverses the given-side sales (restoring inventory), removes the trade transactions, and soft-deletes the received lots. If any received item has already been sold, deletion will be blocked."
        confirmLabel="Delete trade"
        loading={del.isPending}
        onCancel={() => { setConfirmDelete(false); del.reset() }}
        onConfirm={() => del.mutate()}
      />
    </>
  )
}
