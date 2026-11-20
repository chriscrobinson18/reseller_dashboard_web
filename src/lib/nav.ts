import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Deep links between pages. Each page opens the record named in its query
 * param, even when it is outside the page's selected period:
 *   /expenses?tx=   /sales?sale=   /inventory?lot=
 *   /bundles?bundle=   /trades?trade=   /breakdowns?breakdown=
 * Used by LinkedRecords (src/components/LinkedRecords.tsx).
 */
export type RecordKind = 'transaction' | 'sale' | 'lot' | 'bundle' | 'trade' | 'breakdown'

const ROUTES: Record<RecordKind, [path: string, param: string]> = {
  transaction: ['/expenses', 'tx'],
  sale: ['/sales', 'sale'],
  lot: ['/inventory', 'lot'],
  bundle: ['/bundles', 'bundle'],
  trade: ['/trades', 'trade'],
  breakdown: ['/breakdowns', 'breakdown'],
}

export function recordHref(kind: RecordKind, id: string): string {
  const [path, param] = ROUTES[kind]
  return `${path}?${param}=${encodeURIComponent(id)}`
}

/** The id in this page's deep-link param (or null) and a function that removes it. */
export function useDeepLink(kind: RecordKind): [string | null, () => void] {
  const [sp, setSp] = useSearchParams()
  const param = ROUTES[kind][1]
  const value = sp.get(param)
  const clear = useCallback(() => {
    setSp(prev => {
      if (!prev.has(param)) return prev
      const next = new URLSearchParams(prev)
      next.delete(param)
      return next
    }, { replace: true })
  }, [setSp, param])
  return [value, clear]
}
