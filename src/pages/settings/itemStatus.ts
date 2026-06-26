import type { PlaidItem } from '../../lib/types'

export type ItemStatusBadge = 'connected' | 'syncing' | 'reconnect' | 'error'

export function getItemStatus(item: PlaidItem, isSyncing: boolean): ItemStatusBadge {
  if (isSyncing) return 'syncing'
  switch (item.status) {
    case 'login_required':
      return 'reconnect'
    case 'error':
      return 'error'
    case 'active':
    default:
      return 'connected'
  }
}
