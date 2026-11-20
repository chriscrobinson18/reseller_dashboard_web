import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Scale } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { fetchAllRows } from '../lib/fetchAll'
import { pairNetZero } from '../lib/mutations'
import { formatUSD, formatShortDate } from '../lib/utils'
import {
  NET_ZERO_SELECT, isPairable, rankNetZeroCandidates, proposeNetZeroPairs,
  type NetZeroRow, type NetZeroProposal,
} from '../lib/netZero'
import Modal from './Modal'
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
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['transactions', 'net-zero-candidates', tx.id, tx.amount],
    enabled: eligible,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select(NET_ZERO_SELECT)
        .gte('amount', target - 0.005)
        .lte('amount', target + 0.005)
        .is('net_zero_pair_id', null)
        .neq('id', tx.id)
        .limit(200)
      if (error) throw error
      return (data ?? []) as NetZeroRow[]
    },
  })
  const ranked = useMemo(() => rankNetZeroCandidates(tx, rows).slice(0, 8), [tx, rows])
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
        <div className="text-xs text-gray-400">No unpaired transaction with the exact opposite amount.</div>
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
      {err && <div className="text-xs text-red-600 mt-1.5">{err}</div>}
    </div>
  )
}

const shiftDays = (d: string, n: number) => {
  const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10)
}
const keyOf = (p: NetZeroProposal) => `${p.negative.id}|${p.positive.id}`

/**
 * Bulk finder: scans unpaired rows in the period (± maxDays so a refund in
 * the next month still matches), proposes one-to-one exact-opposite pairs,
 * and pairs the ticked ones. Same-merchant pairs ≤ 90 days are pre-ticked.
 */
export function NetZeroFinderModal({ open, onClose, start, end }: { open: boolean; onClose: () => void; start: string | null; end: string | null }) {
  const qc = useQueryClient()
  const maxDays = 120
  const { data: rows, isLoading, error } = useQuery({
    queryKey: ['transactions', 'net-zero-scan', start, end],
    enabled: open,
    queryFn: () => fetchAllRows<NetZeroRow>((from, to) => {
      // null start/end = "All time": no bound on that side.
      let q = supabase.from('transactions').select(NET_ZERO_SELECT).is('net_zero_pair_id', null)
      if (start) q = q.gte('date', shiftDays(start, -maxDays))
      if (end) q = q.lte('date', shiftDays(end, maxDays))
      return q.order('id').range(from, to)
    }),
  })
  const proposals = useMemo(() => proposeNetZeroPairs(rows ?? [], {
    maxDays, inScope: r => (!start || r.date >= start) && (!end || r.date <= end),
  }), [rows, start, end])

  const [ticked, setTicked] = useState<Set<string> | null>(null)
  const defaultTicked = useMemo(() => new Set(proposals.filter(p => p.sameMerchant && p.days <= 90).map(keyOf)), [proposals])
  const sel = ticked ?? defaultTicked
  const toggle = (k: string) => { const s = new Set(sel); if (s.has(k)) s.delete(k); else s.add(k); setTicked(s) }

  const [result, setResult] = useState<{ ok: number; failed: string[] } | null>(null)
  const run = useMutation({
    mutationFn: async () => {
      let ok = 0; const failed: string[] = []
      for (const p of proposals) {
        if (!sel.has(keyOf(p))) continue
        try { await pairNetZero(p.negative.id, p.positive.id); ok++ }
        catch (e) { failed.push(`${p.negative.merchant ?? '—'} ${formatUSD(p.negative.amount)}: ${(e as Error).message}`) }
      }
      return { ok, failed }
    },
    onSuccess: r => { setResult(r); setTicked(null); qc.invalidateQueries({ queryKey: ['transactions'] }) },
  })

  const close = () => { setResult(null); setTicked(null); onClose() }

  return (
    <Modal open={open} onClose={close} title="Net-zero matches" width="max-w-2xl">
      <p className="text-xs text-gray-500 mb-3">
        Unpaired transactions in this period whose amount is cancelled exactly (to the cent) by another
        transaction within {maxDays} days. Pairing removes both from Schedule C (e.g. a charge and its full refund).
        Partial refunds don't match: those stay as separate rows. Marketplace report rows, trades and sale-linked rows are never proposed.
      </p>
      {result && (
        <div className={`text-xs rounded-lg p-2.5 mb-3 ${result.failed.length ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>
          Paired {result.ok}.{result.failed.length > 0 && <> Not paired: {result.failed.join('; ')}</>}
        </div>
      )}
      {isLoading ? (
        <div className="text-sm text-gray-400 py-6 text-center">Scanning…</div>
      ) : error ? (
        <div className="text-sm text-red-600">{(error as Error).message}</div>
      ) : proposals.length === 0 ? (
        <div className="text-sm text-gray-400 py-6 text-center">No exact opposite-amount matches found.</div>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
            <span>{proposals.length} possible pair{proposals.length === 1 ? '' : 's'} · {sel.size} selected</span>
            <span className="space-x-3">
              <button className="text-blue-600 hover:underline" onClick={() => setTicked(new Set(proposals.map(keyOf)))}>All</button>
              <button className="text-blue-600 hover:underline" onClick={() => setTicked(new Set())}>None</button>
            </span>
          </div>
          <div className="space-y-2">
            {proposals.map(p => {
              const k = keyOf(p)
              return (
                <label key={k} className={`flex gap-2.5 border rounded-lg p-2.5 cursor-pointer ${sel.has(k) ? 'border-gray-900 bg-gray-50' : 'border-gray-200'}`}>
                  <input type="checkbox" className="mt-1" checked={sel.has(k)} onChange={() => toggle(k)} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <RowLine r={p.negative} />
                    <RowLine r={p.positive} />
                    <div className="text-[10px] text-gray-400">
                      {p.sameMerchant ? 'Same merchant' : <span className="text-amber-600">Different merchant — check it's really the same purchase</span>} · {p.days} day{p.days === 1 ? '' : 's'} apart
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-gray-100">
            <button onClick={close} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">Close</button>
            <button
              onClick={() => run.mutate()}
              disabled={sel.size === 0 || run.isPending}
              className="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
            >
              {run.isPending ? 'Pairing…' : `Pair ${sel.size} selected`}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
