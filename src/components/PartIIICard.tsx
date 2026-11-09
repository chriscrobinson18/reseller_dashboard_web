import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { formatUSD } from '../lib/utils'
import { useInventoryValuations } from '../lib/queries'
import { saveInventoryValuation, type InventoryValuationInput } from '../lib/mutations'
import { computeScheduleCSummary } from '../lib/csvExport'
import {
  computePartIII, inventoryOnHandAsOf,
  type LotForValuation, type MovementForValuation,
} from '../lib/partIII'
import type { CustomCategory } from '../lib/categories'
import type { Transaction } from '../lib/types'

/**
 * Schedule C Part III (traditional §471 method) for one FULL tax year,
 * independent of the dashboard period picker — Part III is never
 * period-scoped (docs/features/dashboard.md). Year-end values live in
 * `inventory_valuations`; beginning inventory is the prior year's row.
 */

const METHOD_LABELS: Record<InventoryValuationInput['method'], string> = {
  count: 'Physical count',
  estimate: 'Estimate',
  lots: 'From inventory lots',
  filed_return: 'From filed return',
}

async function fetchYearTransactions(year: number): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .gte('date', `${year}-01-01`)
    .lte('date', `${year}-12-31`)
    .limit(5000)
  if (error) throw error
  return data ?? []
}

async function fetchLotData(): Promise<{ lots: LotForValuation[]; movements: MovementForValuation[] }> {
  const [lotsRes, movRes] = await Promise.all([
    supabase.from('inventory_lots')
      .select('id, quantity_remaining, unit_cost, purchase_date, created_at, deleted_at')
      .is('deleted_at', null)
      .limit(10000),
    supabase.from('inventory_movements')
      .select('inventory_lot_id, quantity, sales(sold_at, deleted_at)')
      .limit(20000),
  ])
  if (lotsRes.error) throw lotsRes.error
  if (movRes.error) throw movRes.error
  type MovRow = { inventory_lot_id: string; quantity: number; sales: { sold_at: string; deleted_at: string | null } | { sold_at: string; deleted_at: string | null }[] | null }
  const movements: MovementForValuation[] = ((movRes.data ?? []) as MovRow[]).map(m => {
    const sale = Array.isArray(m.sales) ? m.sales[0] : m.sales
    return {
      inventory_lot_id: m.inventory_lot_id,
      quantity: m.quantity,
      sold_at: sale && !sale.deleted_at ? sale.sold_at : null,
    }
  })
  return { lots: (lotsRes.data ?? []) as LotForValuation[], movements }
}

function Row({ line, label, value, strong, warn }: { line: string; label: string; value: number; strong?: boolean; warn?: string }) {
  return (
    <div className="flex justify-between items-start gap-3 py-1.5 border-b border-gray-100 last:border-0">
      <span className={`text-sm min-w-0 ${strong ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
        <span className="text-gray-400 mr-1.5 tabular-nums">{line}</span>{label}
        {warn && <span className="block text-xs text-amber-700 mt-0.5">{warn}</span>}
      </span>
      <span className={`text-sm tabular-nums shrink-0 ${strong ? 'font-semibold text-gray-900' : 'font-medium text-gray-800'}`}>
        {formatUSD(value)}
      </span>
    </div>
  )
}

function ValuationEditor({
  year, current, suggestion, onSaved,
}: {
  year: number
  current?: { ending_inventory: number; method: InventoryValuationInput['method']; notes: string | null }
  suggestion?: number
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(current ? String(current.ending_inventory) : '')
  const [method, setMethod] = useState<InventoryValuationInput['method']>(current?.method ?? 'count')
  const [notes, setNotes] = useState(current?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) {
    return (
      <button
        onClick={() => {
          setValue(current ? String(current.ending_inventory) : '')
          setMethod(current?.method ?? 'count')
          setNotes(current?.notes ?? '')
          setError(null)
          setOpen(true)
        }}
        className="text-xs font-medium text-blue-600 hover:text-blue-800"
      >
        {current ? `Edit ${year} year-end value` : `Set ${year} year-end value`}
      </button>
    )
  }

  async function save() {
    const n = Number(value)
    if (value.trim() === '' || !Number.isFinite(n) || n < 0) { setError('Enter an amount of 0 or more.'); return }
    setSaving(true); setError(null)
    try {
      await saveInventoryValuation({ taxYear: year, endingInventory: n, method, notes })
      setOpen(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
      <div className="text-xs font-semibold text-gray-700">Inventory on hand at Dec 31, {year} (at cost)</div>
      <div className="flex flex-wrap gap-2">
        <input
          type="number" inputMode="decimal" min="0" step="0.01" value={value}
          onChange={e => setValue(e.target.value)}
          className="w-36 rounded-md border border-gray-300 px-2 py-1 text-sm tabular-nums"
          aria-label={`Ending inventory ${year}`}
        />
        <select
          value={method} onChange={e => setMethod(e.target.value as InventoryValuationInput['method'])}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          aria-label="How the value was determined"
        >
          {Object.entries(METHOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {suggestion !== undefined && (
        <button
          onClick={() => { setValue(suggestion.toFixed(2)); setMethod('lots') }}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          Use lot-based figure ({formatUSD(suggestion)})
        </button>
      )}
      <input
        type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes for your preparer (optional)"
        className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
      />
      {error && <div className="text-xs text-red-600">{error}</div>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving}
          className="rounded-md bg-gray-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => setOpen(false)} className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700">
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function PartIIICard({ customs }: { customs: CustomCategory[] }) {
  const thisYear = new Date().getFullYear()
  const years = useMemo(() => Array.from({ length: thisYear - 2024 + 1 }, (_, i) => thisYear - i), [thisYear])
  const [year, setYear] = useState(thisYear - 1)
  const qc = useQueryClient()

  const { data: valuations = [] } = useInventoryValuations()
  const { data: txYear = [], isLoading } = useQuery({
    queryKey: ['transactions', 'part-iii', year],
    queryFn: () => fetchYearTransactions(year),
  })
  const { data: lotData } = useQuery({ queryKey: ['inventory', 'valuation-lots'], queryFn: fetchLotData })

  // Purchases use exactly the Summary CSV's rules (sale-derived / settlement /
  // net-zero / excluded rows skipped), so the card and the export agree.
  const purchases = useMemo(() => computeScheduleCSummary(txYear, customs).purchases, [txYear, customs])
  const p = useMemo(() => computePartIII(year, purchases, valuations), [year, purchases, valuations])
  const suggest = (y: number) => lotData ? inventoryOnHandAsOf(lotData.lots, lotData.movements, `${y}-12-31`) : undefined
  const sEnd = suggest(year), sBegin = suggest(year - 1)
  const rowFor = (y: number) => valuations.find(v => v.tax_year === y)
  const onSaved = () => qc.invalidateQueries({ queryKey: ['inventory_valuations'] })

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Part III — Cost of Goods Sold</h2>
        <select value={year} onChange={e => setYear(Number(e.target.value))}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm" aria-label="Tax year">
          {years.map(y => <option key={y} value={y}>{y} tax year</option>)}
        </select>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Traditional method: beginning + purchases − ending, always for the full tax year. Feeds Schedule C Line 4 in the Summary CSV when you export “Last Year”.
      </p>

      <Row line="35" label="Inventory at beginning of year" value={p.beginningInventory}
        warn={p.beginningSet ? undefined : `Not set — enter the ${year - 1} year-end value${year - 1 <= 2024 ? ' from your filed return' : ''}.`} />
      <div className="pb-1"><ValuationEditor key={`b${year}`} year={year - 1} current={rowFor(year - 1)} suggestion={sBegin?.value} onSaved={onSaved} /></div>
      <Row line="36" label={`Purchases${isLoading ? ' (loading…)' : ''}`} value={p.purchases} />
      <Row line="40" label="Lines 35 through 39" value={p.line40} />
      <Row line="41" label="Inventory at end of year" value={p.endingInventory}
        warn={p.endingSet ? undefined : 'Not set — count or estimate inventory on hand at Dec 31.'} />
      <div className="pb-1"><ValuationEditor key={`e${year}`} year={year} current={rowFor(year)} suggestion={sEnd?.value} onSaved={onSaved} /></div>
      <Row line="42" label="Cost of goods sold → Line 4" value={p.cogs} strong />

      {sEnd && (
        <p className="text-xs text-gray-400 mt-2">
          Lot-based figure for Dec 31, {year}: {formatUSD(sEnd.value)} ({sEnd.units} units in {sEnd.lotCount} lots). Only counts lots you’ve entered, so treat it as a starting point.
        </p>
      )}
      {!p.complete && (
        <p className="text-xs text-amber-700 mt-2">Part III is incomplete until both inventory values are set.</p>
      )}
    </div>
  )
}
