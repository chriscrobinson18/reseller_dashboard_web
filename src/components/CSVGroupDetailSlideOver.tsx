import { useState, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import SlideOver from './SlideOver'
import {
  getTransferRow, getNonTransferRows, getExpectedDeposit,
  isLinkedGroup, getLinkedSettlementId,
  getNetTotal, getAdjustedTotal, getClosingReserve,
} from '../lib/queries'
import {
  markTransactionAsSettlement, linkCSVGroupToSettlement,
  unlinkCSVGroup, insertTransaction,
} from '../lib/mutations'
import { supabase } from '../lib/supabase'
import type { CSVGroup, Transaction } from '../lib/types'

type Props = {
  group: CSVGroup
  platform: string
  open: boolean
  onClose: () => void
  onLinked: () => void
}

const CATEGORY_LABELS: Record<string, string> = {
  payout: 'Revenue',
  commissions_fees: 'Fees',
  shipping_postage: 'Shipping',
  advertising: 'Advertising',
  other_expense: 'Other',
  balance_adjustment: 'Adjustment',
  taxes_licenses: 'Tax Withheld',
  transfer: 'Payout',
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtUSD(n: number) {
  const abs = Math.abs(n)
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `−$${str}` : `$${str}`
}

function platformDisplayName(p: string) {
  if (p === 'ebay') return 'eBay'
  if (p === 'amazon') return 'Amazon'
  return p.charAt(0).toUpperCase() + p.slice(1)
}

export default function CSVGroupDetailSlideOver({ group, platform, open, onClose, onLinked }: Props) {
  const qc = useQueryClient()
  const [isSearching, setIsSearching] = useState(false)
  const [candidates, setCandidates] = useState<Transaction[]>([])
  const [isNearMatch, setIsNearMatch] = useState(false)
  const [isLinking, setIsLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [isUnlinking, setIsUnlinking] = useState(false)
  const [showCandidates, setShowCandidates] = useState(false)

  // Reset search state when group changes
  useEffect(() => {
    setCandidates([])
    setIsNearMatch(false)
    setShowCandidates(false)
    setLinkError(null)
  }, [group.groupId])

  const nonTransfer = getNonTransferRows(group)
  const transferRow = getTransferRow(group)
  const expectedDeposit = getExpectedDeposit(group)
  const netTotal = getNetTotal(group)
  const adjustedTotal = getAdjustedTotal(group)
  const closingReserve = getClosingReserve(group)
  const linked = isLinkedGroup(group)
  const linkedId = getLinkedSettlementId(group)

  // Date range of non-transfer rows
  const dates = nonTransfer.map(t => t.date).sort()
  const dateMin = dates[0]
  const dateMax = dates[dates.length - 1]

  async function findMatch() {
    if (expectedDeposit === undefined) return
    setIsSearching(true)
    setCandidates([])
    setLinkError(null)
    setShowCandidates(false)

    const searchEnd = dateMax
      ? new Date(new Date(dateMax).getTime() + 14 * 86400000).toISOString().slice(0, 10)
      : undefined

    // Exact match first
    const { data: exact } = await supabase
      .from('transactions')
      .select('*')
      .eq('source', 'plaid')
      .eq('amount', expectedDeposit)
      .gte('date', dateMin ?? '2000-01-01')
      .lte('date', searchEnd ?? '2099-12-31')
      .neq('record_type', 'settlement')
      .order('date')

    if ((exact ?? []).length > 0) {
      setCandidates(exact as Transaction[])
      setIsNearMatch(false)
    } else {
      // Near-match: within ±$5.00
      const lo = expectedDeposit - 5
      const hi = expectedDeposit + 5
      const { data: near } = await supabase
        .from('transactions')
        .select('*')
        .eq('source', 'plaid')
        .gte('amount', lo)
        .lte('amount', hi)
        .gte('date', dateMin ?? '2000-01-01')
        .lte('date', searchEnd ?? '2099-12-31')
        .neq('record_type', 'settlement')
        .order('date')
      setCandidates((near ?? []) as Transaction[])
      setIsNearMatch(true)
    }

    setIsSearching(false)
    setShowCandidates(true)
  }

  async function linkTo(candidate: Transaction) {
    setIsLinking(true)
    setLinkError(null)
    try {
      // If near-match, auto-create a gap expense
      if (isNearMatch && expectedDeposit !== undefined) {
        const gap = expectedDeposit - candidate.amount  // positive = received less (expense); negative = received more (income)
        if (Math.abs(gap) > 0) {
          await insertTransaction({
            date: candidate.date,
            amount: -gap,
            merchant: `${platformDisplayName(platform)} Disbursement Fee`,
            type: 'fee',
            scheduleCCategory: 'commissions_fees',
            notes: null,
          })
        }
      }
      await markTransactionAsSettlement(candidate.id, platform)
      await linkCSVGroupToSettlement(group.groupId, candidate.id, platform)
      qc.invalidateQueries({ queryKey: ['csv-groups', platform] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onLinked()
      onClose()
    } catch (e: unknown) {
      setLinkError(e instanceof Error ? e.message : 'Link failed')
    }
    setIsLinking(false)
  }

  async function handleUnlink() {
    setIsUnlinking(true)
    try {
      await unlinkCSVGroup(group.groupId, platform)
      qc.invalidateQueries({ queryKey: ['csv-groups', platform] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onLinked()
      onClose()
    } catch (e: unknown) {
      setLinkError(e instanceof Error ? e.message : 'Unlink failed')
    }
    setIsUnlinking(false)
  }

  return (
    <SlideOver open={open} onClose={onClose} title="Settlement Group">
      <div className="space-y-6 p-4">

        {/* Summary */}
        <section>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Summary</h3>
          <div className="bg-gray-50 rounded-lg p-4 space-y-1 text-sm">
            <SummaryRow label="Net activity" value={netTotal} />
            {group.priorBalance !== 0 && (
              <SummaryRow label="Prior balance" value={group.priorBalance} />
            )}
            <SummaryRow label="Adjusted total" value={adjustedTotal} bold />
            {expectedDeposit !== undefined && (
              <SummaryRow label="Expected deposit" value={expectedDeposit} />
            )}
            {closingReserve !== undefined && closingReserve !== 0 && (
              <SummaryRow label="Closing reserve" value={closingReserve} />
            )}
          </div>
        </section>

        {/* Bank Match */}
        <section>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Bank Match</h3>
          {linked && linkedId ? (
            <LinkedState linkedId={linkedId} onUnlink={handleUnlink} isUnlinking={isUnlinking} />
          ) : expectedDeposit !== undefined ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={findMatch}
                disabled={isSearching}
                className="w-full py-2 px-4 rounded-lg border border-blue-300 text-blue-700 text-sm font-medium hover:bg-blue-50 disabled:opacity-50"
              >
                {isSearching ? 'Searching...' : 'Find Plaid Match'}
              </button>
              {showCandidates && candidates.length === 0 && (
                <p className="text-sm text-gray-500 text-center">No matching bank transactions found.</p>
              )}
              {showCandidates && candidates.length > 0 && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  {isNearMatch && (
                    <div className="bg-amber-50 border-b border-amber-100 px-3 py-2 text-xs text-amber-700">
                      No exact match found. These are close — selecting one will auto-create a gap adjustment expense.
                    </div>
                  )}
                  {candidates.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => linkTo(c)}
                      disabled={isLinking}
                      className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-0 disabled:opacity-50 text-left"
                    >
                      <div>
                        <div className="text-sm font-medium text-gray-900">{c.merchant ?? 'Deposit'}</div>
                        <div className="text-xs text-gray-500">{fmtDate(c.date)} · {c.account_display ?? ''}</div>
                      </div>
                      <span className="text-sm font-semibold text-green-700">{fmtUSD(c.amount)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              {platformDisplayName(platform)} held these funds in reserve — no bank deposit was made for this period.
              {closingReserve !== undefined && closingReserve > 0
                ? ` The balance (${fmtUSD(closingReserve)}) carries forward into the next payout. No action needed.`
                : ' No action needed.'}
            </p>
          )}
          {/* Error display outside the conditional so it shows for both link and unlink errors */}
          {linkError && <p className="mt-2 text-sm text-red-600">{linkError}</p>}
        </section>

        {/* Transactions */}
        <section>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Transactions ({nonTransfer.length})
          </h3>
          <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
            {[...nonTransfer].sort((a, b) => a.date.localeCompare(b.date)).map(tx => (
              <div key={tx.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <div>
                  <div className="text-gray-900 truncate max-w-[220px]">{tx.merchant ?? tx.type}</div>
                  <div className="text-xs text-gray-500">
                    {fmtDate(tx.date)} · {CATEGORY_LABELS[tx.schedule_c_category ?? ''] ?? tx.schedule_c_category}
                  </div>
                </div>
                <span className={tx.amount >= 0 ? 'text-green-700 font-medium' : 'text-gray-700'}>
                  {fmtUSD(tx.amount)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Payout row */}
        {transferRow && (
          <section>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Payout Row (stored)</h3>
            <div className="flex items-center justify-between px-3 py-2 text-sm border border-gray-200 rounded-lg">
              <div>
                <div className="text-gray-900">{transferRow.merchant ?? 'Payout'}</div>
                <div className="text-xs text-gray-500">{fmtDate(transferRow.date)}</div>
              </div>
              <span className="text-gray-700">{fmtUSD(transferRow.amount)}</span>
            </div>
          </section>
        )}

      </div>
    </SlideOver>
  )
}

function SummaryRow({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  const cls = bold ? 'font-semibold' : ''
  return (
    <div className={`flex justify-between ${cls}`}>
      <span className="text-gray-600">{label}</span>
      <span className={value < 0 ? 'text-red-600' : 'text-gray-900'}>{fmtUSD(value)}</span>
    </div>
  )
}

function LinkedState({ linkedId, onUnlink, isUnlinking }: {
  linkedId: string; onUnlink: () => void; isUnlinking: boolean
}) {
  const [details, setDetails] = useState<Transaction | null>(null)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let mounted = true
    setLoadError(false)
    supabase.from('transactions').select('*').eq('id', linkedId).single()
      .then(({ data, error }) => {
        if (!mounted) return
        if (error || !data) { setLoadError(true); return }
        setDetails(data as Transaction)
      })
    return () => { mounted = false }
  }, [linkedId])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-sm">
        <span className="text-green-600">✓</span>
        <div className="flex-1">
          {loadError ? (
            <span className="text-gray-500">Unable to load deposit details</span>
          ) : details ? (
            <span className="text-gray-900">
              {details.account_display ?? details.merchant ?? 'Bank deposit'} · {fmtDate(details.date)} · {fmtUSD(details.amount)}
            </span>
          ) : (
            <span className="text-gray-500">Loading...</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onUnlink}
        disabled={isUnlinking}
        className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
      >
        {isUnlinking ? 'Removing...' : 'Remove Match'}
      </button>
    </div>
  )
}
