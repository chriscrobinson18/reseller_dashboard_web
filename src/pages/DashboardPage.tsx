import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { supabase } from '../lib/supabase'
import { getPeriodRange, PERIOD_LABELS, type PeriodPreset } from '../lib/periods'
import { CATEGORIES, resolveCategory, type CustomCategory, type CategoryDef } from '../lib/categories'
import { useCustomCategories } from '../lib/queries'
import { computeScheduleC, computeKPIs, computeMonthlyChart } from '../lib/scheduleCMath'
import { computeSalesIncome, computeSalesIncomeByMonth, type BundleIncomeInput } from '../lib/salesIncome'
import { formatUSD } from '../lib/utils'
import { buildScheduleCTransactionsCSV, buildScheduleCSummaryCSV, downloadCSV } from '../lib/csvExport'
import { Download } from 'lucide-react'
import PeriodPicker from '../components/PeriodPicker'
import type { Transaction, Sale } from '../lib/types'

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchTransactions(start: string | null, end: string | null): Promise<Transaction[]> {
  let q = supabase
    .from('transactions')
    .select('*')
    .order('date', { ascending: false })
  if (start) q = q.gte('date', start)
  if (end) q = q.lte('date', end)
  const { data, error } = await q.limit(5000)
  if (error) throw error
  return data ?? []
}

async function fetchSales(start: string | null, end: string | null): Promise<Sale[]> {
  let q = supabase
    .from('sales')
    .select('*, items(id,name,category), inventory_movements(id,quantity,inventory_lots(unit_cost,item_id))')
    .is('deleted_at', null)
    .order('sold_at', { ascending: false })
  if (start) q = q.gte('sold_at', start + 'T00:00:00Z')
  if (end) q = q.lte('sold_at', end + 'T23:59:59Z')
  const { data, error } = await q.limit(2000)
  if (error) throw error
  return data ?? []
}

type BundleRow = BundleIncomeInput & { id: string; platform: string | null; external_order_id: string | null }

/** Order-level fees/shipping live on sale_bundles (lines store 0); fetched so
 *  sales-based income counts them once. Same sold_at period filter as sales. */
async function fetchBundles(start: string | null, end: string | null): Promise<BundleRow[]> {
  let q = supabase
    .from('sale_bundles')
    .select('id, sold_at, fees, shipping_cost, platform, external_order_id, deleted_at')
    .is('deleted_at', null)
  if (start) q = q.gte('sold_at', start + 'T00:00:00Z')
  if (end) q = q.lte('sold_at', end + 'T23:59:59Z')
  const { data, error } = await q.limit(2000)
  if (error) throw error
  return (data ?? []) as BundleRow[]
}

// ─── Computation helpers ──────────────────────────────────────────────────────

/**
 * Period-scoped profitability for the dashboard's Sales Profitability card.
 *
 * IMPORTANT: This MUST NOT be reused to compute the Schedule C Part III COGS line.
 * Part III COGS uses `beginning + purchases − ending` over the FULL tax year,
 * independent of any dashboard period filter. See docs/features/dashboard.md
 * "Part III (Cost of Goods Sold) and inventory valuation".
 */
function computeProfitability(sales: Sale[]) {
  const active = sales.filter(s => s.return_status !== 'full' && !s.deleted_at)
  const revenue = active.reduce((s, sale) => {
    const refund = sale.return_status === 'partial' ? (sale.refunded_amount ?? 0) : 0
    return s + sale.sale_price - refund
  }, 0)
  const cogs = active.reduce((s, sale) => {
    if (!sale.inventory_movements) return s
    return s + sale.inventory_movements.reduce((ms, m) =>
      ms + m.quantity * (m.inventory_lots?.unit_cost ?? 0), 0)
  }, 0)
  const fees = active.reduce((s, sale) => s + (sale.fees ?? 0), 0)
  const shipping = active.reduce((s, sale) => s + (sale.shipping_cost ?? 0), 0)
  return { revenue, cogs, grossProfit: revenue - cogs, fees, shipping, sellingMargin: revenue - cogs - fees - shipping }
}


// ─── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({ label, value, positive }: { label: string; value: number; positive?: boolean }) {
  const isPositive = positive !== undefined ? positive : value >= 0
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs text-gray-500 font-medium mb-1">{label}</div>
      <div className={`text-lg sm:text-xl font-semibold tabular-nums break-words ${isPositive ? 'text-gray-900' : 'text-red-500'}`}>
        {formatUSD(value)}
      </div>
    </div>
  )
}

function ProfitRow({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex justify-between items-center gap-3 py-1.5 border-b border-gray-100 last:border-0">
      <span className={`text-sm min-w-0 ${muted ? 'text-gray-400' : 'text-gray-700'}`}>{label}</span>
      <span className={`text-sm font-medium tabular-nums shrink-0 ${value < 0 ? 'text-red-500' : muted ? 'text-gray-400' : 'text-gray-900'}`}>
        {formatUSD(value)}
      </span>
    </div>
  )
}

function ScheduleCSection({ title, rows }: { title: string; rows: Array<{ label: string; value: number; line?: string }> }) {
  const total = rows.reduce((s, r) => s + r.value, 0)
  if (total === 0 && rows.length === 0) return null
  return (
    <div className="mb-4">
      <div className="flex justify-between items-center gap-3 mb-1">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide min-w-0">{title}</span>
        <span className="text-sm font-semibold text-gray-900 tabular-nums shrink-0">{formatUSD(total)}</span>
      </div>
      {rows.filter(r => r.value !== 0).map(r => (
        <div key={r.label} className="flex justify-between items-center gap-3 py-1 border-b border-gray-50">
          <span className="text-xs text-gray-600 min-w-0">
            {r.line && <span className="text-gray-400 mr-1.5">{r.line}</span>}
            {r.label}
          </span>
          <span className="text-xs font-medium tabular-nums text-gray-800 shrink-0">{formatUSD(r.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [period, setPeriod] = useState<PeriodPreset>('ytd')
  const range = getPeriodRange(period)

  const { data: transactions = [], isLoading: loadingTx } = useQuery({
    queryKey: ['transactions', range.start, range.end],
    queryFn: () => fetchTransactions(range.start, range.end),
  })

  const { data: sales = [], isLoading: loadingSales } = useQuery({
    queryKey: ['sales', 'dashboard', range.start, range.end],
    queryFn: () => fetchSales(range.start, range.end),
  })

  const { data: bundles = [], isLoading: loadingBundles } = useQuery({
    queryKey: ['sale_bundles', 'dashboard', range.start, range.end],
    queryFn: () => fetchBundles(range.start, range.end),
  })

  const { data: customs = [] } = useCustomCategories()

  // Income comes from the Sales tab (2026-11-09) — see src/lib/salesIncome.ts.
  const salesIncome = useMemo(() => computeSalesIncome(sales, bundles), [sales, bundles])
  const salesByMonth = useMemo(() => computeSalesIncomeByMonth(sales, bundles), [sales, bundles])

  const kpis = useMemo(() => computeKPIs(transactions, customs, salesIncome), [transactions, customs, salesIncome])
  const profitability = useMemo(() => computeProfitability(sales), [sales])
  const monthlyData = useMemo(() => computeMonthlyChart(transactions, customs, salesByMonth), [transactions, customs, salesByMonth])
  const scheduleC = useMemo(() => computeScheduleC(transactions, customs, salesIncome), [transactions, customs, salesIncome])

  // Note: scheduleC values are SIGNED. For Part I, positive = income (display as is).
  // For Part II/III (expenses/COGS), values are negative; we display the absolute value
  // and let the section total show as a positive expense magnitude.
  // Sales income is merged in (payout = Line 1 gross, returns_allowances = Line 2 refunds,
  // commissions_fees / shipping_postage = Line 10 / 27a); sale-derived transactions are
  // excluded by bucketTransaction so nothing is counted twice.
  const allCategories = useMemo<CategoryDef[]>(() => {
    const customsResolved = customs
      .map((c: CustomCategory) => resolveCategory(c.value, customs))
      .filter((c): c is CategoryDef => !!c)
    return [...CATEGORIES, ...customsResolved]
  }, [customs])

  const partI = allCategories
    .filter(c => c.scheduleLine === 'Part I'
      && scheduleC[c.value] !== undefined && scheduleC[c.value] !== 0)
    .map(c => ({ label: c.label, value: scheduleC[c.value] ?? 0 }))

  const partIII = allCategories
    .filter(c => c.scheduleLine === 'Part III'
      && scheduleC[c.value] !== undefined && scheduleC[c.value] !== 0)
    .map(c => ({ label: c.label, value: Math.abs(scheduleC[c.value] ?? 0) }))

  const partII = allCategories
    .filter(c => c.scheduleLine?.startsWith('Line')
      && scheduleC[c.value] !== undefined && scheduleC[c.value] !== 0)
    .map(c => ({ label: c.label, value: Math.abs(scheduleC[c.value] ?? 0), line: c.scheduleLine }))

  const uncategorized = transactions.filter(t =>
    !t.schedule_c_category &&
    t.record_type !== 'settlement' &&
    !t.related_sale_id &&
    t.source !== 'csv_import'
  ).length

  const loading = loadingTx || loadingSales || loadingBundles

  const periodSlug = `${(range.start ?? 'all').slice(0, 10)}-to-${(range.end ?? 'now').slice(0, 10)}`

  function handleExportTransactions() {
    downloadCSV(
      `schedule-c-transactions-${periodSlug}.csv`,
      buildScheduleCTransactionsCSV(transactions, customs, sales, bundles),
    )
  }

  function handleExportSummary() {
    downloadCSV(
      `schedule-c-summary-${periodSlug}.csv`,
      buildScheduleCSummaryCSV(transactions, customs, PERIOD_LABELS[period], salesIncome),
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1 className="text-lg font-semibold text-gray-900">
          Dashboard <span className="text-gray-500 font-normal">— {PERIOD_LABELS[period]}</span>
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {loading && <span className="text-xs text-gray-400 mr-1">Loading…</span>}
          <button
            onClick={handleExportSummary}
            disabled={transactions.length === 0 && sales.length === 0}
            title="Download the Schedule C summary (one row per IRS line) for this period"
            className="flex items-center gap-1.5 border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download size={14} /> Summary<span className="hidden sm:inline"> CSV</span>
          </button>
          <button
            onClick={handleExportTransactions}
            disabled={transactions.length === 0 && sales.length === 0}
            title="Download this period's business transactions as a Schedule C ledger CSV"
            className="flex items-center gap-1.5 border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download size={14} /> Transactions<span className="hidden sm:inline"> CSV</span>
          </button>
        </div>
      </div>

      {/* Period picker */}
      <PeriodPicker value={period} onChange={setPeriod} />

      {/* Uncategorized warning */}
      {uncategorized > 0 && (
        <Link
          to="/expenses?cat=__uncategorized__"
          className="block bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm text-amber-800 hover:bg-amber-100 transition-colors"
        >
          ⚠️ <strong>{uncategorized}</strong> transactions need a category — click to categorize.
        </Link>
      )}

      {/* KPI row */}
      {/* Phones: Income | Expenses side by side, Net full-width beneath. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4">
        <KpiCard label="Total Income" value={kpis.income} positive />
        <KpiCard label="Total Expenses" value={kpis.expenses} positive={false} />
        <div className="col-span-2 sm:col-span-1"><KpiCard label="Net" value={kpis.net} /></div>
      </div>

      {/* Profitability + Schedule C side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Profitability card */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Sales Profitability</h2>
          <ProfitRow label="Gross Revenue" value={profitability.revenue} />
          <ProfitRow label="Cost of Goods (COGS)" value={-profitability.cogs} />
          <ProfitRow label="Gross Profit" value={profitability.grossProfit} />
          <ProfitRow label="Platform Fees" value={-profitability.fees} muted />
          <ProfitRow label="Shipping Cost" value={-profitability.shipping} muted />
          <div className="mt-2 pt-2 border-t border-gray-200 flex justify-between">
            <span className="text-sm font-semibold text-gray-900">Selling Margin</span>
            <span className={`text-sm font-semibold tabular-nums ${profitability.sellingMargin < 0 ? 'text-red-500' : 'text-green-600'}`}>
              {formatUSD(profitability.sellingMargin)}
            </span>
          </div>
          {profitability.revenue > 0 && (
            <div className="text-xs text-gray-400 text-right mt-0.5">
              {((profitability.sellingMargin / profitability.revenue) * 100).toFixed(1)}% margin
            </div>
          )}
        </div>

        {/* Schedule C */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5 md:overflow-y-auto md:max-h-72">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Schedule C Breakdown</h2>
          {partI.length > 0 && <ScheduleCSection title="Part I — Income" rows={partI} />}
          {partIII.length > 0 && <ScheduleCSection title="Part III — COGS" rows={partIII} />}
          {partII.length > 0 && <ScheduleCSection title="Part II — Expenses" rows={partII} />}
          {partI.length === 0 && partII.length === 0 && partIII.length === 0 && (
            <p className="text-xs text-gray-400">No categorized transactions in this period.</p>
          )}
        </div>
      </div>

      {/* Monthly chart */}
      {monthlyData.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Monthly Overview</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyData} barGap={2}>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} width={52} />
              <Tooltip
                formatter={(value) => formatUSD(Number(value))}
                labelStyle={{ fontSize: 12 }}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="income" name="Income" fill="#10b981" radius={[3, 3, 0, 0]} />
              <Bar dataKey="expenses" name="Expenses" fill="#f87171" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
