import { useState, useMemo } from 'react'
import { formatUSD, formatDate } from '../lib/utils'
import { useBoxOpeningsWithItems } from '../lib/queries'
import BoxOpeningDetailSlideOver from '../components/BoxOpeningDetailSlideOver'

export default function BreakdownsPage() {
  const [openBoxOpeningId, setOpenBoxOpeningId] = useState<string | null>(null)
  const { data: rows = [], isLoading } = useBoxOpeningsWithItems()

  const breakdowns = useMemo(() => {
    const open = rows.filter(b => b.status === 'open').sort((a, b) => b.opened_at.localeCompare(a.opened_at))
    const closed = rows.filter(b => b.status === 'closed').sort((a, b) => b.opened_at.localeCompare(a.opened_at))
    return [...open, ...closed]
  }, [rows])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-6 border-b border-gray-200 bg-white">
        <h1 className="text-lg font-semibold text-gray-900">Breakdowns</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : breakdowns.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            No breakdowns yet — use "Breakdown Inventory" on the Inventory page to open a box.
          </div>
        ) : (
          breakdowns.map(b => (
            <div
              key={b.id}
              onClick={() => setOpenBoxOpeningId(b.id)}
              className="rounded-lg border border-gray-200 bg-white shadow-sm cursor-pointer hover:border-gray-300 hover:shadow transition-all"
            >
              {/* Card header */}
              <div className="px-4 py-3 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{b.box_name}</span>
                    <span className="text-xs text-gray-400">{formatDate(b.opened_at)}</span>
                  </div>
                  <div className="text-sm text-gray-500 mt-0.5">
                    {b.box_cost !== null ? formatUSD(b.box_cost) : '—'}
                  </div>
                </div>
                {b.status === 'open' ? (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">In Progress</span>
                ) : (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">Closed</span>
                )}
              </div>

              {/* Divider */}
              <div className="border-t border-gray-100" />

              {/* Card body — items */}
              <div className="px-4 py-2">
                {b.pullCount === 0 ? (
                  <div className="py-1 text-sm text-gray-400 italic">No pulls yet</div>
                ) : (
                  b.lots.map(lot => (
                    <div key={lot.id} className="flex items-center justify-between py-1">
                      <span className="text-sm text-gray-700">{lot.items?.name ?? '—'}</span>
                      <span className="text-sm tabular-nums text-gray-600">{formatUSD(lot.unit_cost)}</span>
                    </div>
                  ))
                )}
              </div>

              {/* Card footer — pool remaining (open breakdowns with known box_cost only) */}
              {b.status === 'open' && b.remainingBasis !== null && (
                <>
                  <div className="border-t border-gray-100" />
                  <div className="px-4 py-2 flex items-center justify-between">
                    <span className="text-xs text-gray-500">Pool remaining</span>
                    <span className={`text-sm tabular-nums font-medium ${b.remainingBasis < 0.01 ? 'text-green-600' : 'text-gray-700'}`}>
                      {formatUSD(b.remainingBasis)} of {formatUSD(b.box_cost!)}
                    </span>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
        {breakdowns.length} {breakdowns.length === 1 ? 'breakdown' : 'breakdowns'}
      </div>

      <BoxOpeningDetailSlideOver
        boxOpeningId={openBoxOpeningId}
        onClose={() => setOpenBoxOpeningId(null)}
      />
    </div>
  )
}
