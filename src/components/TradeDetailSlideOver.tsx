import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
  })

  if (!tradeId) return null

  return (
    <>
      <SlideOver open={!!tradeId} onClose={onClose} title="Trade" width="w-[520px]">
        {isLoading || !data ? (
          <div className="text-xs text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-5 text-sm">
            <div>
              <div className="text-xs text-gray-500">Trade date</div>
              <div className="font-medium">{formatDate(data.trade.traded_at)}</div>
            </div>
            {data.trade.counterparty && (
              <div>
                <div className="text-xs text-gray-500">Counterparty</div>
                <div className="font-medium">{data.trade.counterparty}</div>
              </div>
            )}
            {data.trade.fmv_source_notes && (
              <div>
                <div className="text-xs text-gray-500">FMV source</div>
                <div>{data.trade.fmv_source_notes}</div>
              </div>
            )}
            {data.trade.notes && (
              <div>
                <div className="text-xs text-gray-500">Notes</div>
                <div>{data.trade.notes}</div>
              </div>
            )}

            <div>
              <h3 className="text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wide">You gave</h3>
              <table className="w-full text-xs">
                <tbody>
                  {data.givenSales.map(s => (
                    <tr key={s.id} className="border-b border-gray-100 last:border-0">
                      <td className="py-1.5">{s.items?.name ?? '—'}</td>
                      <td className="py-1.5 text-right tabular-nums">×{s.quantity}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatUSD(s.sale_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wide">You received</h3>
              <table className="w-full text-xs">
                <tbody>
                  {data.receivedLots.map(l => (
                    <tr key={l.id} className="border-b border-gray-100 last:border-0">
                      <td className="py-1.5">{l.items?.name ?? '—'}</td>
                      <td className="py-1.5 text-right tabular-nums">×{l.quantity_purchased}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatUSD(l.unit_cost * l.quantity_purchased)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wide">Transactions</h3>
              <table className="w-full text-xs">
                <tbody>
                  {data.incomeTransaction && (
                    <tr className="border-b border-gray-100"><td className="py-1.5">Income (non-cash)</td><td className="py-1.5 text-right tabular-nums">{formatUSD(data.incomeTransaction.amount)}</td></tr>
                  )}
                  {data.cogsTransaction && (
                    <tr className="border-b border-gray-100"><td className="py-1.5">COGS (non-cash)</td><td className="py-1.5 text-right tabular-nums">{formatUSD(data.cogsTransaction.amount)}</td></tr>
                  )}
                  {data.cashTransaction && (
                    <tr><td className="py-1.5">Cash boot</td><td className="py-1.5 text-right tabular-nums">{formatUSD(data.cashTransaction.amount)}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="pt-3 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-xs text-red-600 hover:underline"
              >
                Delete trade
              </button>
              {del.isError && <div className="text-xs text-red-600 mt-2">{(del.error as Error).message}</div>}
            </div>
          </div>
        )}
      </SlideOver>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete trade?"
        message="This reverses the given-side sales (restoring inventory), removes the trade transactions, and soft-deletes the received lots. If any received item has already been sold, deletion will be blocked."
        confirmLabel="Delete trade"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => del.mutate()}
      />
    </>
  )
}
