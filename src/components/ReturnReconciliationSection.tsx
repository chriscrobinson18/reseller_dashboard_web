import { useState } from 'react'
import { useCSVReturnCandidates } from '../lib/csvReturns'
import { formatUSD, formatDate } from '../lib/utils'
import ReconcileReturnModal from './modals/ReconcileReturnModal'
import type { CSVReturnCandidate } from '../lib/csvReturns'

/**
 * Detected-but-unapplied CSV returns: a `csv_import` refund row (+ maybe a
 * return-shipping label) that matches an inventory-linked sale by order ref,
 * but hasn't been routed through `record_return` yet. Review-gated by design
 * — nothing here mutates until the user picks "Reconcile" on a row. See
 * docs/features/settings.md#return-reconciliation.
 *
 * ⚠️ DO NOT ship this to production before the `csv_return_reconciliation`
 * migration + `record_return`/`reverse_return` v2 are deployed — see the
 * 2026-08-27 Deployment note in docs/supabase-schema.md. The live (pre-v2)
 * `record_return` silently ignores the new `refund_transaction_id` param and
 * inserts a duplicate refund transaction instead of re-tagging the CSV row,
 * double-deducting the same real-world refund.
 */
export default function ReturnReconciliationSection() {
  const [platform, setPlatform] = useState<'ebay' | 'amazon'>('ebay')
  const { data: candidates = [], isLoading } = useCSVReturnCandidates(platform)
  const [selected, setSelected] = useState<CSVReturnCandidate | null>(null)

  const unmatchedCount = candidates.filter(c => c.candidateSales.length === 0).length

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Return Reconciliation</h2>
        {candidates.length > 0 && (
          <span className="text-sm font-medium text-amber-600">
            {candidates.length} detected{unmatchedCount > 0 ? ` · ${unmatchedCount} unmatched` : ''}
          </span>
        )}
      </div>

      <div className="flex rounded-lg border border-gray-200 overflow-hidden w-fit">
        {(['ebay', 'amazon'] as const).map(p => (
          <button
            key={p}
            type="button"
            onClick={() => setPlatform(p)}
            className={`px-4 py-1.5 text-sm font-medium ${
              platform === p ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {p === 'ebay' ? 'eBay' : 'Amazon'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-500 py-4 text-center">Loading...</div>
      ) : candidates.length === 0 ? (
        <div className="text-sm text-gray-500 py-4 text-center border border-gray-200 rounded-lg bg-white">
          No unreconciled {platform === 'ebay' ? 'eBay' : 'Amazon'} returns detected.
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
          {candidates.map(c => {
            const unmatched = c.candidateSales.length === 0
            const ambiguous = c.candidateSales.length > 1
            return (
              <button
                key={`${c.orderRef}-${c.refundTransaction.id}`}
                type="button"
                onClick={() => setSelected(c)}
                className="w-full flex items-center gap-3 p-4 hover:bg-gray-50 text-left"
              >
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${unmatched ? 'bg-gray-300' : ambiguous ? 'bg-amber-400' : 'bg-blue-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900">
                    Order {c.orderRef}
                    <span className="font-normal text-gray-500 ml-1">— {formatDate(c.refundTransaction.date)}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Refund {formatUSD(Math.abs(c.refundTransaction.amount))}
                    {c.shippingCandidate && <> · Return shipping {formatUSD(Math.abs(c.shippingCandidate.amount))}</>}
                  </div>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  unmatched ? 'bg-gray-100 text-gray-500' : ambiguous ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                }`}>
                  {unmatched ? 'Unmatched' : ambiguous ? `${c.candidateSales.length} sales match` : 'Review'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {selected && (
        <ReconcileReturnModal
          open={selected !== null}
          onClose={() => setSelected(null)}
          candidate={selected}
          platform={platform}
        />
      )}
    </section>
  )
}
