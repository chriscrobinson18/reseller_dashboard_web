import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Scale } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { fetchAllRows } from '../lib/fetchAll'
import { pairNetZero, unpairNetZero } from '../lib/mutations'
import { formatUSD, formatShortDate } from '../lib/utils'
import {
  NET_ZERO_SELECT, isPairable, cancelsOut, rankNetZeroCandidates, daysApart,
  type NetZeroRow,
} from '../lib/netZero'
import CategoryBadge from './CategoryBadge'

function RowLine({ r }: { r: NetZeroRow }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-500 tabular-nums shrink-0">{formatShortDate(r.date)}</span>
        <span className="font-medium text-gray-800 truncate">{r.merchant ?? '—'}</span>
        <span className={`ml-auto tabular-nums font-medium shrink-0 ${r.amount < 0 ? 'text-gray-900' : 'text-emerald-600'}`}>
          {formatUSD(r.amount)}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-400 min-w-0">
        <span className="truncate">{r.account_display ?? ''}</span>
        {r.schedule_c_category && <CategoryBadge value={r.schedule_c_category} size="xs" />}
      </div>
    </div>
  )
}

/**
 * Detail-panel section: looks up every unpaired transaction with the exact
 * opposite amount (any date) and offers a one-click pair.
 */
export function NetZeroCandidates({ tx, onPaired }: { tx: NetZeroRow; onPaired?: () => void }) {
  const qc = useQueryClient()
  const eligible = isPairable(tx)
  const target = -Number(tx.amount)
  const { data, isLoading } = useQuery({
    queryKey: ['transactions', 'net-zero-candidates', tx.id, tx.amount],
    enabled: eligible,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select(NET_ZERO_SELECT)
        .gte('amount', target - 0.005)
        .lte('amount', target + 0.005)
        .neq('id', tx.id)
        .limit(200)
      if (error) throw error
      const all = (data ?? []) as NetZeroRow[]
      // Opposite-amount rows that are already paired: fetch their partners so
      // the panel can say where the match went instead of just "none".
      const pairIds = [...new Set(all.map(r => r.net_zero_pair_id).filter((x): x is string => !!x))]
      let partners: NetZeroRow[] = []
      if (pairIds.length) {
        const { data: pd, error: pe } = await supabase
          .from('transactions').select(NET_ZERO_SELECT).in('net_zero_pair_id', pairIds.slice(0, 50))
        if (pe) throw pe
        partners = (pd ?? []) as NetZeroRow[]
      }
      return { all, partners }
    },
  })
  const all = useMemo(() => data?.all ?? [], [data])
  const ranked = useMemo(() => rankNetZeroCandidates(tx, all).slice(0, 8), [tx, all])
  const taken = useMemo(() => all
    .filter(r => r.net_zero_pair_id && cancelsOut(tx.amount, r.amount))
    .map(r => ({ row: r, partner: (data?.partners ?? []).find(p => p.net_zero_pair_id === r.net_zero_pair_id && p.id !== r.id) ?? null }))
    .sort((a, b) => a.row.date.localeCompare(b.row.date))
    .slice(0, 5), [tx.amount, all, data])
  const [err, setErr] = useState<string | null>(null)
  const pair = useMutation({
    mutationFn: (otherId: string) => pairNetZero(tx.id, otherId),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['transactions'] }); onPaired?.() },
    onError: (e: Error) => setErr(e.message),
  })

  if (!eligible) return null
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500 mb-1.5">
        <Scale size={12} /> Net-zero match <span className="font-normal text-gray-400">· exact {formatUSD(target)}</span>
      </div>
      {isLoading ? (
        <div className="text-xs text-gray-400">Looking for opposite amounts…</div>
      ) : ranked.length === 0 ? (
        <div className="text-xs text-gray-400">
          {taken.length ? 'No unpaired match: every exact opposite amount is already in a net-zero pair (below).' : 'No transaction with the exact opposite amount.'}
        </div>
      ) : (
        <div className="space-y-1.5">
          {ranked.map(c => (
            <div key={c.row.id} className="flex items-center gap-2 border border-gray-200 rounded-lg p-2">
              <RowLine r={c.row} />
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="text-[10px] text-gray-400">{c.sameMerchant ? 'same merchant · ' : ''}{c.days}d apart</span>
                <button
                  onClick={() => pair.mutate(c.row.id)}
                  disabled={pair.isPending}
                  className="px-2.5 py-1 rounded-md bg-gray-900 text-white text-xs font-medium hover:bg-gray-700 disabled:opacity-50"
                  title="Pair as net zero: both rows drop out of Schedule C"
                >
                  Pair
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {!isLoading && taken.length > 0 && (
        <div className="mt-2 space-y-1.5">
          <div className="text-[11px] text-gray-400">Already paired: Unpair it first (on either row) to use it here</div>
          {taken.map(({ row, partner }) => (
            <div key={row.id} className="border border-dashed border-gray-200 rounded-lg p-2 opacity-75">
              <RowLine r={row} />
              <div className="text-[11px] text-gray-500 mt-1">
                Paired with {partner ? <>{formatShortDate(partner.date)} · {partner.merchant ?? '—'} · {partner.account_display ?? ''} · {formatUSD(partner.amount)}</> : <span className="text-amber-600">a missing row (orphaned pair)</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {err && <div className="text-xs text-red-600 mt-1.5">{err}</div>}
    </div>
  )
}

/**
 * "Net-zero pairs" view on the Expenses page: every pair with at least one
 * side in the selected period, both rows shown (the partner is fetched even
 * when it falls outside the period). Pairs are created from a transaction's
 * detail panel ("Net-zero match"); here they are reviewed or unpaired.
 */
export function NetZeroPairsView({ start, end, search, onOpen }: {
  start: string | null
  end: string | null
  search: string
  onOpen: (id: string) => void
}) {
  const qc = useQueryClient()
  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ['transactions', 'net-zero-pairs', start, end],
    queryFn: async () => {
      const inPeriod = await fetchAllRows<NetZeroRow>((from, to) => {
        let q = supabase.from('transactions').select(NET_ZERO_SELECT).not('net_zero_pair_id', 'is', null)
        if (start) q = q.gte('date', start)
        if (end) q = q.lte('date', end)
        return q.order('id').range(from, to)
      })
      const pairIds = [...new Set(inPeriod.map(r => r.net_zero_pair_id!))]
      const have = new Set(inPeriod.map(r => r.id))
      const partners: NetZeroRow[] = []
      for (let i = 0; i < pairIds.length; i += 200) {
        const { data, error: e } = await supabase.from('transactions').select(NET_ZERO_SELECT).in('net_zero_pair_id', pairIds.slice(i, i + 200))
        if (e) throw e
        for (const r of (data ?? []) as NetZeroRow[]) if (!have.has(r.id)) partners.push(r)
      }
      return [...inPeriod, ...partners]
    },
  })

  const pairs = useMemo(() => {
    const byPair = new Map<string, NetZeroRow[]>()
    for (const r of rows) {
      const g = byPair.get(r.net_zero_pair_id!) ?? []
      g.push(r); byPair.set(r.net_zero_pair_id!, g)
    }
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return [...byPair.entries()]
      .map(([pairId, members]) => {
        const sorted = [...members].sort((a, b) => a.amount - b.amount)
        const netCents = sorted.reduce((t, r) => t + Math.round(r.amount * 100), 0)
        const dates = sorted.map(r => r.date).sort()
        return {
          pairId, members: sorted, netCents,
          gross: sorted.filter(r => r.amount < 0).reduce((t, r) => t - r.amount, 0),
          days: dates.length > 1 ? daysApart(dates[0], dates[dates.length - 1]) : 0,
          latest: dates[dates.length - 1],
          problem: sorted.length !== 2 ? (sorted.length === 1 ? 'Partner missing (orphaned)' : `${sorted.length} rows share this pair`) : netCents !== 0 ? 'Amounts do not cancel' : null,
        }
      })
      .filter(p => !terms.length || terms.every(t => p.members.some(r =>
        (r.merchant ?? '').toLowerCase().includes(t) || Math.abs(r.amount).toFixed(2).includes(t.replace(/[$,-]/g, '')) || (r.account_display ?? '').toLowerCase().includes(t))))
      .sort((a, b) => Number(!!b.problem) - Number(!!a.problem) || b.latest.localeCompare(a.latest))
  }, [rows, search])

  const [confirmId, setConfirmId] = useState<string | null>(null)
  const unpair = useMutation({
    mutationFn: (pairId: string) => unpairNetZero(pairId),
    onSuccess: () => { setConfirmId(null); qc.invalidateQueries({ queryKey: ['transactions'] }) },
  })

  if (isLoading) return <div className="p-8 text-center text-gray-400 text-sm">Loading net-zero pairs…</div>
  if (error) return <div className="p-8 text-center text-red-600 text-sm">{(error as Error).message}</div>

  const problems = pairs.filter(p => p.problem).length
  const gross = pairs.reduce((t, p) => t + p.gross, 0)
  return (
    <div className="p-4 md:p-6 space-y-3">
      <div className="text-xs text-gray-500">
        {pairs.length} pair{pairs.length === 1 ? '' : 's'} · {formatUSD(gross)} of charges excluded from Schedule C
        {problems > 0 && <span className="text-amber-600"> · {problems} need attention</span>}
        <div className="text-gray-400 mt-0.5">Pair a transaction from its detail panel (Net-zero match). Click a row to open it.</div>
      </div>
      {pairs.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">No net-zero pairs in this period.</div>
      ) : pairs.map(p => (
        <div key={p.pairId} className={`border rounded-xl p-3 ${p.problem ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`}>
          <div className="space-y-1.5">
            {p.members.map(r => (
              <button key={r.id} type="button" onClick={() => onOpen(r.id)} className="w-full text-left flex rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-gray-50">
                <RowLine r={r} />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100 text-[11px]">
            {p.problem
              ? <span className="text-amber-700 font-medium">{p.problem}</span>
              : <span className="text-gray-400">Nets to $0.00 · {p.days} day{p.days === 1 ? '' : 's'} apart</span>}
            <span className="ml-auto" />
            {confirmId === p.pairId ? (
              <>
                <span className="text-gray-500">Both rows count again?</span>
                <button type="button" onClick={() => unpair.mutate(p.pairId)} disabled={unpair.isPending} className="px-2 py-0.5 rounded bg-gray-900 text-white font-medium disabled:opacity-50">Unpair</button>
                <button type="button" onClick={() => setConfirmId(null)} className="px-2 py-0.5 text-gray-500 hover:text-gray-800">Cancel</button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmId(p.pairId)} className="text-blue-600 hover:text-blue-800 font-medium">Unpair</button>
            )}
          </div>
        </div>
      ))}
      {unpair.isError && <div className="text-xs text-red-600">{(unpair.error as Error).message}</div>}
    </div>
  )
}
