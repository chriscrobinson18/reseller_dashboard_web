import { useState } from 'react'
import { formatUSD, formatDate } from '../lib/utils'
import { useBundles } from '../lib/queries'
import BundleDetailSlideOver from '../components/BundleDetailSlideOver'

export default function BundlesPage() {
  const [openBundleId, setOpenBundleId] = useState<string | null>(null)
  const { data: bundles = [], isLoading } = useBundles()

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 md:p-6 border-b border-gray-200 bg-white">
        <h1 className="text-lg font-semibold text-gray-900">Bundles</h1>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : bundles.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            No bundle sales yet. Bundle a sale from the Sales page.
          </div>
        ) : (
          <>
          {/* Phones: card list */}
          <ul className="md:hidden divide-y divide-gray-100 bg-white">
            {bundles.map(b => (
              <li key={b.id} onClick={() => setOpenBundleId(b.id)} className="px-4 py-3 active:bg-gray-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900">
                      {b.platform ?? '—'} · {b.itemCount} {b.itemCount === 1 ? 'item' : 'items'}
                    </div>
                    <div className="text-xs text-gray-500 tabular-nums">{formatDate(b.sold_at)}</div>
                    {b.external_order_id && (
                      <div className="text-xs text-gray-400 font-mono break-all">{b.external_order_id}</div>
                    )}
                  </div>
                  <div className="shrink-0 text-sm font-semibold tabular-nums text-gray-900">{formatUSD(b.netPayout)}</div>
                </div>
              </li>
            ))}
          </ul>
          <table className="hidden md:table w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b border-gray-200 z-10">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Date</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Platform</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">Order ID</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Items</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-gray-500">Net Payout</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map(b => (
                <tr
                  key={b.id}
                  onClick={() => setOpenBundleId(b.id)}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2.5 text-gray-600 tabular-nums">{formatDate(b.sold_at)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{b.platform ?? '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500 font-mono text-xs">{b.external_order_id ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right text-gray-500 tabular-nums">{b.itemCount}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium text-gray-900">
                    {formatUSD(b.netPayout)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-200 bg-white text-xs text-gray-400">
        {bundles.length} {bundles.length === 1 ? 'bundle' : 'bundles'}
      </div>

      <BundleDetailSlideOver bundleId={openBundleId} onClose={() => setOpenBundleId(null)} />
    </div>
  )
}
