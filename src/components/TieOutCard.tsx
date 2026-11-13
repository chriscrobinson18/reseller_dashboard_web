import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { fetchTieOutData } from '../lib/tieOutData'
import { formatUSD } from '../lib/utils'
import {
  computeTieOut, incomeDepositsNeedingSales, compareEbaySources, computePlatformLedger, applyLedgers,
  LEDGER_PLATFORMS, TIE_OUT_TOLERANCE, type TieOutPlatform, type PlatformLedger,
} from '../lib/tieOut'

/**
 * Year-End Tie-Out (docs/features/dashboard.md): completeness insurance for
 * sales-based income. For one FULL tax year (own selector, never
 * period-scoped) it compares each platform's recorded sales with its
 * settlement deposits, lists deposits still counted as income, and checks
 * eBay Order Earnings against the eBay Transaction Report. Read-only.
 */

const PLATFORM_LABELS: Record<string, string> = {
  ebay: 'eBay', tcgplayer: 'TCGplayer', amazon: 'Amazon', paypal: 'PayPal', cashapp: 'Cash App',
  psa: 'PSA', manual: 'Manual', mercari: 'Mercari', unassigned: 'Unassigned',
  venmo: 'Venmo', zelle: 'Zelle', goldin: 'Goldin', cash: 'Cash (in person)',
}
const platformLabel = (p: string) => PLATFORM_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1)

function Status({ p }: { p: TieOutPlatform }) {
  if (p.ledger && !p.flags.length) {
    return <span className="text-xs font-medium text-green-700">Explained by the {platformLabel(p.platform)} report</span>
  }
  if (p.flags.length) {
    return (
      <div className="space-y-1">
        {p.flags.map(f => (
          <span key={f} className="block text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{f}</span>
        ))}
      </div>
    )
  }
  if (p.saleCount > 0 && p.depositCount > 0) return <span className="text-xs font-medium text-green-700">Ties</span>
  if (p.notes.length) {
    return (
      <div className="space-y-1">
        {p.notes.map(n => <span key={n} className="block text-xs text-gray-600">{n}</span>)}
      </div>
    )
  }
  if (p.platform === 'cash') return <span className="text-xs text-gray-500">Cash: no deposits expected</span>
  if (p.depositCount === 0) return <span className="text-xs text-gray-500">No deposits under this platform</span>
  return null
}

const diffClass = (n: number) => (Math.abs(n) < 0.005 ? 'text-gray-500' : n > 0 ? 'text-amber-700' : 'text-gray-800')

function MonthTable({ p }: { p: TieOutPlatform }) {
  return (
    <table className="w-full text-xs tabular-nums">
      <thead>
        <tr className="text-gray-500">
          <th className="text-left font-medium py-1">Month</th>
          <th className="text-right font-medium py-1">Sales</th>
          <th className="text-right font-medium py-1">Sales net</th>
          <th className="text-right font-medium py-1">Deposits</th>
          <th className="text-right font-medium py-1">Diff</th>
        </tr>
      </thead>
      <tbody>
        {p.months.map(m => {
          const d = Math.round((m.deposits - m.salesNet) * 100) / 100
          const gap = m.deposits > 0 && m.saleCount === 0
          return (
            <tr key={m.month} className={`border-t border-gray-100 ${gap ? 'bg-amber-50' : ''}`}>
              <td className="py-1">{m.month}</td>
              <td className="text-right py-1">{m.saleCount}</td>
              <td className="text-right py-1">{formatUSD(m.salesNet)}</td>
              <td className="text-right py-1">{formatUSD(m.deposits)}</td>
              <td className={`text-right py-1 ${diffClass(d)}`}>{formatUSD(d)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

const signed = (n: number) => (n < 0 ? '−' : '+') + formatUSD(Math.abs(n))

function Line({ label, value, strong, muted }: { label: React.ReactNode; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 py-0.5 ${strong ? 'font-semibold text-gray-900 border-t border-gray-200 mt-1 pt-1' : muted ? 'text-gray-500' : 'text-gray-700'}`}>
      <span className="min-w-0">{label}</span><span className="tabular-nums shrink-0">{value}</span>
    </div>
  )
}

/**
 * eBay/Amazon: recorded sales → report payouts → bank deposits, every line
 * from data. The bridge is exact by construction; the only "unexplained"
 * money is payouts that don't match a bank deposit.
 */
function LedgerBridge({ l }: { l: PlatformLedger }) {
  const name = platformLabel(l.platform)
  return (
    <div className="text-xs space-y-3">
      <div>
        <Line label="Recorded sales net (Sales tab)" value={formatUSD(l.recordedNet)} />
        <Line label={`Sales tab vs ${name} report, ${l.orderDiffs.length} order${l.orderDiffs.length === 1 ? '' : 's'}`} value={signed(l.orderDifference)} />
        {l.separateLabels !== 0 && (
          <Line
            muted value=""
            label={<>of which labels bought separately (the Sales tab charges each to its order; the report bills it without one). Remaining: {signed(l.orderDifferenceAfterLabels)}</>}
          />
        )}
        {l.notOnOrders.map(n => <Line key={n.label} label={<>{n.label} <span className="text-gray-400">({n.count})</span></>} value={signed(n.amount)} />)}
        <Line label={l.balanceChange >= 0 ? `Added to balance held on ${name}` : `Paid out from balance held on ${name}`} value={signed(-l.balanceChange)} />
        <Line label={`Payouts in the ${name} report (${l.reportPayoutCount})`} value={formatUSD(l.reportPayouts)} strong />
        <Line label={`Bank deposits (${l.bankDepositCount})`} value={formatUSD(l.bankDeposits)} />
        {l.transferFees > 0 && <Line label={`Instant-transfer fees kept by ${name} (${l.feeMatched.length})`} value={signed(-l.transferFees)} muted />}
        {l.beforeReport.length > 0 && <Line label={`Payouts of a balance from before the report starts (${l.beforeReport.length})`} value={signed(l.beforeReport.reduce((t, d) => t + d.amount, 0))} muted />}
        <Line label="Unexplained" value={formatUSD(l.unexplained)} strong />
      </div>

      {(l.unmatchedReportPayouts.length > 0 || l.unmatchedBankDeposits.length > 0) && (
        <div>
          <div className="font-medium text-gray-900 mb-1">Unmatched payouts</div>
          {l.unmatchedReportPayouts.map(p => (
            <div key={`r${p.date}${p.amount}`} className="flex justify-between text-amber-800">
              <span>{p.date}: in the {name} report, no bank deposit found</span><span className="tabular-nums">{formatUSD(p.amount)}</span>
            </div>
          ))}
          {l.unmatchedBankDeposits.map(p => (
            <div key={`b${p.date}${p.amount}`} className="flex justify-between text-amber-800">
              <span>{p.date}: bank deposit not in the {name} report</span><span className="tabular-nums">{formatUSD(p.amount)}</span>
            </div>
          ))}
          <p className="text-gray-500 mt-1">A missing deposit is usually in the bank feed under another category or account. Tag it as a {name} settlement.</p>
        </div>
      )}

      {l.orderDiffs.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium text-gray-900">Orders where the Sales tab and the report differ ({l.orderDiffs.length})</summary>
          <p className="text-gray-500 my-1">
            Usually fees or labels the two sources book differently (e.g. a label bought separately, a performance fee), a refund of a prior-year
            sale, or a sale not recorded. Income and fees on Schedule C come from the Sales tab.
          </p>
          <table className="w-full tabular-nums">
            <thead><tr className="text-gray-500"><th className="text-left font-medium">Order</th><th className="text-left font-medium">Date</th><th className="text-right font-medium">Sales tab</th><th className="text-right font-medium">Report</th><th className="text-right font-medium">Diff</th></tr></thead>
            <tbody>
              {l.orderDiffs.slice(0, 100).map(d => (
                <tr key={d.orderId + d.date} className="border-t border-gray-100">
                  <td className="py-0.5">{d.orderId}</td><td>{d.date}</td>
                  <td className="text-right">{d.recorded == null ? 'not recorded' : formatUSD(d.recorded)}</td>
                  <td className="text-right">{d.report == null ? 'not in report' : formatUSD(d.report)}</td>
                  <td className="text-right">{signed(d.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {l.orderDiffs.length > 100 && <p className="text-gray-500 mt-1">Showing the 100 largest.</p>}
        </details>
      )}
    </div>
  )
}

function PlatformDetail({ p }: { p: TieOutPlatform }) {
  return p.ledger ? <LedgerBridge l={p.ledger} /> : <MonthTable p={p} />
}

function PlatformSection({ platforms }: { platforms: TieOutPlatform[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const toggle = (p: string) => setOpen(o => (o === p ? null : p))
  return (
    <>
      {/* Phone: cards */}
      <div className="md:hidden space-y-2">
        {platforms.map(p => (
          <div key={p.platform} className="border border-gray-200 rounded-lg p-3">
            <button onClick={() => toggle(p.platform)} className="w-full flex items-center justify-between gap-2 text-left">
              <span className="text-sm font-semibold text-gray-900 flex items-center gap-1">
                {open === p.platform ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {platformLabel(p.platform)}
              </span>
              <span className={`text-sm font-semibold tabular-nums ${diffClass(p.difference)}`}>{formatUSD(p.difference)}</span>
            </button>
            <div className="mt-1 grid grid-cols-2 gap-x-3 text-xs text-gray-600 tabular-nums">
              <span>{p.saleCount} sales</span><span className="text-right">{formatUSD(p.salesNet)} net</span>
              <span>{p.depositCount} deposits</span><span className="text-right">{formatUSD(p.deposits)}</span>
            </div>
            <div className="mt-2"><Status p={p} /></div>
            {open === p.platform && (p.ledger || p.months.length > 0) && <div className="mt-2"><PlatformDetail p={p} /></div>}
          </div>
        ))}
      </div>

      {/* md+: table */}
      <table className="hidden md:table w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-200">
            <th className="text-left font-medium py-2">Platform</th>
            <th className="text-right font-medium py-2">Sales</th>
            <th className="text-right font-medium py-2">Sales net</th>
            <th className="text-right font-medium py-2">Deposits</th>
            <th className="text-right font-medium py-2">Deposits − sales</th>
            <th className="text-left font-medium py-2 pl-4 w-72">Status</th>
          </tr>
        </thead>
        <tbody>
          {platforms.map(p => (
            <Fragment key={p.platform}>
              <tr className="border-b border-gray-100 align-top cursor-pointer hover:bg-gray-50" onClick={() => toggle(p.platform)}>
                <td className="py-2 font-medium text-gray-900">
                  <span className="inline-flex items-center gap-1">
                    {open === p.platform ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {platformLabel(p.platform)}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums">{p.saleCount}</td>
                <td className="py-2 text-right tabular-nums">{formatUSD(p.salesNet)}</td>
                <td className="py-2 text-right tabular-nums">{formatUSD(p.deposits)} <span className="text-xs text-gray-400">({p.depositCount})</span></td>
                <td className={`py-2 text-right tabular-nums font-medium ${diffClass(p.difference)}`}>{formatUSD(p.difference)}</td>
                <td className="py-2 pl-4"><Status p={p} /></td>
              </tr>
              {open === p.platform && (p.ledger || p.months.length > 0) && (
                <tr className="border-b border-gray-100 bg-gray-50">
                  <td colSpan={6} className="px-6 py-2"><PlatformDetail p={p} /></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Disclosure({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-gray-100 pt-3 mt-3">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-start justify-between gap-3 text-left">
        <span className="text-sm font-semibold text-gray-900 flex items-center gap-1 min-w-0">
          {open ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
          {title}
        </span>
        <span className="text-xs text-gray-600 tabular-nums shrink-0 text-right">{summary}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

export default function TieOutCard() {
  const thisYear = new Date().getFullYear()
  const years = useMemo(() => Array.from({ length: thisYear - 2025 + 1 }, (_, i) => thisYear - i), [thisYear])
  const [year, setYear] = useState(thisYear)

  const { data, isLoading, error } = useQuery({
    queryKey: ['tie-out', year],
    queryFn: () => fetchTieOutData(supabase, year),
  })

  const platforms = useMemo(() => {
    if (!data) return []
    const ledgers = [...LEDGER_PLATFORMS].map(p => computePlatformLedger(p, year, data.sales, data.ledgerRows, data.ledgerDeposits))
    return applyLedgers(computeTieOut(data.sales, data.deposits, data.prior), ledgers)
  }, [data, year])
  const income = useMemo(() => (data ? incomeDepositsNeedingSales(data.incomeRows) : []), [data])
  const ebay = useMemo(() => (data ? compareEbaySources(data.ebaySales, data.ebayCsv, year) : null), [data, year])

  const flagged = platforms.filter(p => p.flags.length).length
  const incomeTotal = income.reduce((s, t) => s + Number(t.amount), 0)
  const fieldStats = useMemo(() => {
    const stats: Record<string, { n: number; sum: number }> = {}
    for (const m of ebay?.mismatched ?? []) for (const f of m.fields) {
      const s = (stats[f.field] ??= { n: 0, sum: 0 })
      s.n++; s.sum += f.earnings - f.report
    }
    return stats
  }, [ebay])

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h2 className="text-sm font-semibold text-gray-900">Year-End Tie-Out</h2>
        <select value={year} onChange={e => setYear(Number(e.target.value))}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm" aria-label="Tax year">
          {years.map(y => <option key={y} value={y}>{y} tax year</option>)}
        </select>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Proves every sale is recorded: each platform’s settlement deposits should roughly equal the net of its recorded sales
        (full tax year; flagged above the larger of {formatUSD(TIE_OUT_TOLERANCE.abs)} or {TIE_OUT_TOLERANCE.pct * 100}%).
        Small gaps are usually timing (December sales paid in January). eBay and Amazon are reconciled line by line against
        their imported reports (fees, labels, ads, holds, balance held, every payout matched to a bank deposit): click the row
        for the breakdown. TCGplayer pays out on its own schedule, so it isn't checked month by month. In-person sales are
        matched to the wallet they were paid through (PayPal, Venmo, Cash App, Zelle) by their payment method. Read-only.
      </p>

      {isLoading && <p className="text-xs text-gray-400">Loading {year}…</p>}
      {error && <p className="text-xs text-red-600">Couldn’t load the tie-out: {error instanceof Error ? error.message : 'unknown error'}</p>}

      {data && (
        <>
          <p className="text-xs mb-2">
            {flagged === 0
              ? <span className="text-green-700 font-medium">All platforms tie out.</span>
              : <span className="text-amber-800 font-medium">{flagged} of {platforms.length} platforms need a look.</span>}
            <span className="text-gray-500"> Tap a platform for months.</span>
          </p>
          {platforms.length ? <PlatformSection platforms={platforms} /> : <p className="text-xs text-gray-400">No sales or settlement deposits in {year}.</p>}

          <Disclosure title="Deposits still counted as income" summary={`${income.length} · ${formatUSD(incomeTotal)}`}>
            <p className="text-xs text-gray-500 mb-2">
              Bank deposits tagged as income that aren’t linked to a sale. Each one needs its sales recorded; then re-tag it as a settlement so it isn’t counted twice.
            </p>
            {income.length === 0 ? <p className="text-xs text-gray-400">None.</p> : (
              <ul className="divide-y divide-gray-100">
                {income.map(t => (
                  <li key={t.id} className="flex items-start justify-between gap-3 py-1.5 text-xs">
                    <span className="min-w-0">
                      <span className="text-gray-500 tabular-nums mr-2">{t.date}</span>
                      <span className="text-gray-800 break-words">{t.merchant || '—'}</span>
                    </span>
                    <span className="tabular-nums font-medium text-gray-900 shrink-0">{formatUSD(Number(t.amount))}</span>
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>

          {ebay && (
            <Disclosure
              title="eBay: Order Earnings vs Transaction Report"
              summary={`${ebay.matching}/${ebay.ordersCompared} match · ${ebay.onlyInEarnings.length + ebay.onlyInReport.length} one-sided`}
            >
              <p className="text-xs text-gray-500 mb-2">
                Order Earnings is what income uses; the Transaction Report is audit detail. Differences point to report files worth re-importing.
                The Transaction Report usually shows less for shipping labels.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                {(['gross', 'fees', 'shipping', 'refunds'] as const).map(f => (
                  <div key={f} className="rounded-lg bg-gray-50 p-2">
                    <div className="text-xs text-gray-500 capitalize">{f}</div>
                    <div className="text-sm font-semibold tabular-nums">{fieldStats[f]?.n ?? 0} differ</div>
                    <div className="text-xs text-gray-500 tabular-nums">Earnings − report {formatUSD(fieldStats[f]?.sum ?? 0)}</div>
                  </div>
                ))}
              </div>
              {ebay.onlyInEarnings.length > 0 && (
                <p className="text-xs text-gray-700 mb-1 break-words">
                  <span className="font-medium">Only in Order Earnings ({ebay.onlyInEarnings.length}):</span> {ebay.onlyInEarnings.join(', ')}
                </p>
              )}
              {ebay.onlyInReport.length > 0 && (
                <p className="text-xs text-gray-700 mb-1 break-words">
                  <span className="font-medium">Only in Transaction Report ({ebay.onlyInReport.length}):</span> {ebay.onlyInReport.join(', ')}
                </p>
              )}
              {ebay.mismatched.length > 0 && (
                <ul className="mt-2 divide-y divide-gray-100 max-h-72 overflow-y-auto">
                  {ebay.mismatched.map(m => (
                    <li key={m.order} className="py-1.5 text-xs">
                      <div className="flex justify-between gap-2">
                        <span className="font-medium text-gray-800 break-all">{m.order}</span>
                        <span className="text-gray-500 tabular-nums shrink-0">{m.date}</span>
                      </div>
                      <div className="text-gray-600 tabular-nums">
                        {m.fields.map(f => `${f.field}: ${formatUSD(f.earnings)} vs ${formatUSD(f.report)}`).join(' · ')}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Disclosure>
          )}
        </>
      )}
    </div>
  )
}
