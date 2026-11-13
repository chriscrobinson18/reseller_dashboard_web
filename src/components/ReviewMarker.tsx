import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, Lock } from 'lucide-react'
import { setReviewStatus } from '../lib/mutations'
import type { ReviewStatus } from '../lib/types'
import { formatDate } from '../lib/utils'

type Table = 'transactions' | 'sales' | 'inventory_lots'

/** Small pill: "AI reviewed" (amber) or "Reviewed by me" (green, locked). Renders nothing when unreviewed. */
export function ReviewBadge({ status, compact = false }: { status?: ReviewStatus | null; compact?: boolean }) {
  if (!status) return null
  const owner = status === 'owner_reviewed'
  const Icon = owner ? Lock : Bot
  return (
    <span
      title={owner ? 'Reviewed by you: locked against changes by AI and imports' : 'Checked or changed by AI: waiting for your review'}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${
        owner ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
      }`}
    >
      <Icon size={11} />
      {!compact && (owner ? 'Reviewed by me' : 'AI reviewed')}
    </span>
  )
}

/** Detail-panel section: current marker plus the owner's mark / un-mark button. */
export function ReviewControl({ table, id, status: statusProp, reviewedAt: reviewedAtProp, invalidate }: {
  table: Table
  id: string
  status?: ReviewStatus | null
  reviewedAt?: string | null
  /** React Query keys to refresh after a change. */
  invalidate: readonly (readonly unknown[])[]
}) {
  const qc = useQueryClient()
  // Some pages pass a row snapshot that isn't refreshed after a refetch; remember our own write.
  const [local, setLocal] = useState<{ id: string; status: ReviewStatus | null; at: string | null } | null>(null)
  const status = local?.id === id ? local.status : statusProp
  const reviewedAt = local?.id === id ? local.at : reviewedAtProp
  const m = useMutation({
    mutationFn: (s: ReviewStatus | null) => setReviewStatus(table, [id], s),
    onSuccess: (_d, s) => {
      setLocal({ id, status: s, at: s ? new Date().toISOString() : null })
      for (const k of invalidate) qc.invalidateQueries({ queryKey: k })
    },
  })
  const owner = status === 'owner_reviewed'
  return (
    <div>
      <div className="text-xs font-medium text-gray-500 mb-1.5">Review</div>
      <div className="flex items-center gap-2 flex-wrap">
        {status ? <ReviewBadge status={status} /> : <span className="text-xs text-gray-400">Not reviewed</span>}
        {reviewedAt && <span className="text-xs text-gray-400">{formatDate(reviewedAt.slice(0, 10))}</span>}
        <button
          onClick={() => m.mutate(owner ? null : 'owner_reviewed')}
          disabled={m.isPending}
          className={`ml-auto rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
            owner ? 'border-gray-200 text-gray-600 hover:border-gray-400' : 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
          }`}
        >
          {m.isPending ? 'Saving…' : owner ? 'Unlock to edit' : 'Mark reviewed by me'}
        </button>
      </div>
      {owner && (
        <p className="text-xs text-gray-400 mt-1.5">
          Locked: AI and imports can't change its category, links or amounts. Unlock to edit it yourself.
        </p>
      )}
      {m.error && <p className="text-xs text-red-600 mt-1.5">{(m.error as Error).message}</p>}
    </div>
  )
}
