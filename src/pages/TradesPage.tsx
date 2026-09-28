import { useState } from 'react'
import { formatUSD, formatDate } from '../lib/utils'
import { useTrades } from '../lib/queries'
import TradeDetailSlideOver from '../components/TradeDetailSlideOver'

function formatBoot(cash_boot: number | null): { text: string; className: string } {
  if (cash_boot == null || cash_boot === 0) return { text: '—', className: 'text-gray-400' }
  if (cash_boot > 0) return { text: `+${formatUSD(cash_boot)}`, className: 'text-green-600 font-medium' }
  return { text: formatUSD(cash_boot), className: 'text-red-600 font-medium' }
}

export default function TradesPage() {
  const [openTradeId, setOpenTradeId] = useState<string | null>(null)
  const { data: trades = [], isLoading } = useTrades()

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 bg-white">
        <h1 className="text-lg font-semibold text-gray-900">Trades</h1>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : trades.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            No trades yet. Use &#39;Record Trade&#39; on the Inventory page to log one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Date</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Counterparty</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Gave</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Received</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Boot</th>
              </tr>
            </thead>
            <tbody>
              {trades.map(t => {
                const boot = formatBoot(t.cash_boot)
                return (
                  <tr
                    key={t.id}
                    onClick={() => setOpenTradeId(t.id)}
                    className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5 text-gray-600 tabular-nums">{formatDate(t.traded_at)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{t.counterparty ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">
                      {t.given_fmv != null ? formatUSD(t.given_fmv) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">
                      {t.received_fmv != null ? formatUSD(t.received_fmv) : '—'}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${boot.className}`}>
                      {boot.text}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
        {trades.length} {trades.length === 1 ? 'trade' : 'trades'}
      </div>

      <TradeDetailSlideOver tradeId={openTradeId} onClose={() => setOpenTradeId(null)} />
    </div>
  )
}
