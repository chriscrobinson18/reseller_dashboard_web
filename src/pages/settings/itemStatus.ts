import type { PlaidItem } from '../../lib/types'

export type ItemStatusBadge = 'connected' | 'syncing' | 'reconnect' | 'error' | 'stale'

/**
 * An item whose last *successful* sync is older than this is treated as
 * suspect even when it reports no error. `last_synced_at` is only written on a
 * clean run, so a silently-failing item stops advancing it.
 */
export const STALE_AFTER_DAYS = 7

export function daysSinceSync(item: PlaidItem): number | null {
  if (!item.last_synced_at) return null
  const ms = Date.now() - new Date(item.last_synced_at).getTime()
  return Math.floor(ms / 86_400_000)
}

export function isStale(item: PlaidItem): boolean {
  const days = daysSinceSync(item)
  return days !== null && days >= STALE_AFTER_DAYS
}

/**
 * Badge state for a connection.
 *
 * The `stale` case is deliberately symptom-based rather than error-based: it
 * keys off how long it's been since a successful sync, not off a Plaid error
 * code. That's what makes it catch failure modes nothing else classifies — an
 * expired connection once sat green for months because its error was logged
 * server-side and never written to `status`, while `last_synced_at` quietly
 * stopped moving the whole time.
 */
export function getItemStatus(item: PlaidItem, isSyncing: boolean): ItemStatusBadge {
  if (isSyncing) return 'syncing'
  switch (item.status) {
    case 'login_required':
      return 'reconnect'
    case 'error':
      return 'error'
    case 'active':
    default:
      return isStale(item) ? 'stale' : 'connected'
  }
}
