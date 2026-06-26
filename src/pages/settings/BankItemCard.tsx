import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MoreVertical, RefreshCw } from 'lucide-react'
import type { PlaidItem } from '../../lib/types'
import { usePlaidAccounts } from '../../lib/queries'
import { plaidSyncTransactions, plaidRemoveItem } from '../../lib/mutations'
import ConfirmDialog from '../../components/ConfirmDialog'
import AccountRow from './AccountRow'
import { getItemStatus, type ItemStatusBadge } from './itemStatus'

interface Props {
  item: PlaidItem
  /** Parent owns Plaid Link; calls back to launch update mode for this item. */
  onReconnect: () => void
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never synced'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `Synced ${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `Synced ${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `Synced ${days}d ago`
}

function StatusBadge({ status, message }: { status: ItemStatusBadge; message?: string | null }) {
  const styles: Record<ItemStatusBadge, string> = {
    connected: 'bg-green-50 text-green-700 border-green-200',
    syncing: 'bg-amber-50 text-amber-700 border-amber-200',
    reconnect: 'bg-red-50 text-red-700 border-red-200',
    error: 'bg-red-50 text-red-700 border-red-200',
  }
  const labels: Record<ItemStatusBadge, string> = {
    connected: 'Connected',
    syncing: 'Syncing…',
    reconnect: 'Reconnect needed',
    error: 'Error',
  }
  return (
    <span
      title={message ?? undefined}
      className={`text-xs font-medium px-2 py-0.5 rounded-full border ${styles[status]}`}
    >
      {labels[status]}
    </span>
  )
}

export default function BankItemCard({ item, onReconnect }: Props) {
  const qc = useQueryClient()
  const accountsQuery = usePlaidAccounts(item.item_id)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [confirmForceResync, setConfirmForceResync] = useState(false)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const syncMutation = useMutation({
    mutationKey: ['plaidSync', item.id],
    mutationFn: (params: { reset_cursor?: boolean }) =>
      plaidSyncTransactions({ item_id: item.item_id, ...params }),
    onSuccess: (data) => {
      const n = data?.inserted
      setSuccessMsg(
        typeof n === 'number'
          ? `Synced ${n} new transaction${n === 1 ? '' : 's'} from ${item.institution_name ?? 'this bank'}`
          : 'Sync complete'
      )
      qc.invalidateQueries({ queryKey: ['plaid_items'] })
      qc.invalidateQueries({ queryKey: ['plaid_accounts', item.item_id] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      window.setTimeout(() => setSuccessMsg(null), 4000)
    },
  })

  const removeMutation = useMutation({
    mutationFn: () => plaidRemoveItem(item.item_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaid_items'] })
    },
  })

  const status = getItemStatus(item, syncMutation.isPending)

  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      <div className="flex items-center justify-between p-4 border-b border-gray-100">
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900 truncate">
              {item.institution_name ?? 'Unknown institution'}
            </div>
            <div className="text-xs text-gray-500">
              {relativeTime(item.last_synced_at)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={status} message={item.error_message} />
          {status === 'reconnect' && (
            <button
              type="button"
              onClick={onReconnect}
              className="text-xs font-medium text-red-700 border border-red-200 hover:bg-red-50 rounded px-2 py-1"
            >
              Reconnect
            </button>
          )}
          <button
            type="button"
            onClick={() => syncMutation.mutate({})}
            disabled={syncMutation.isPending}
            className="flex items-center gap-1 text-xs font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 rounded px-2 py-1 disabled:opacity-50"
          >
            <RefreshCw size={12} className={syncMutation.isPending ? 'animate-spin' : ''} />
            Sync Now
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen(v => !v)}
              className="p-1 text-gray-400 hover:text-gray-700"
              aria-label="More"
            >
              <MoreVertical size={16} />
            </button>
            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-md z-10"
                onMouseLeave={() => setMenuOpen(false)}
              >
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); setConfirmForceResync(true) }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                >
                  Force Full Resync
                </button>
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); setConfirmDisconnect(true) }}
                  className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {successMsg && (
        <div className="px-4 py-2 text-xs text-green-700 bg-green-50 border-b border-green-100">
          ✓ {successMsg}
        </div>
      )}
      {syncMutation.isError && (
        <div className="px-4 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">
          {(syncMutation.error as Error).message}
        </div>
      )}
      {removeMutation.isError && (
        <div className="px-4 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">
          {(removeMutation.error as Error).message}
        </div>
      )}

      <ul className="py-2">
        {accountsQuery.isPending && (
          <li className="px-4 py-2 text-xs text-gray-400">Loading accounts…</li>
        )}
        {(accountsQuery.data ?? []).map(a => (
          <AccountRow key={a.id} account={a} />
        ))}
        {accountsQuery.data && accountsQuery.data.length === 0 && (
          <li className="px-4 py-2 text-xs text-gray-400">No accounts under this institution.</li>
        )}
      </ul>

      <ConfirmDialog
        open={confirmDisconnect}
        title={`Disconnect ${item.institution_name ?? 'this bank'}?`}
        message="Future syncs will stop. Past transactions will remain on your Expenses page and continue to count for Schedule C."
        confirmLabel="Disconnect"
        loading={removeMutation.isPending}
        onConfirm={() => { removeMutation.mutate(); setConfirmDisconnect(false) }}
        onCancel={() => setConfirmDisconnect(false)}
      />

      <ConfirmDialog
        open={confirmForceResync}
        title={`Re-import all transactions from ${item.institution_name ?? 'this bank'}?`}
        message="This may take up to a minute and will pull historical data again."
        confirmLabel="Re-import"
        loading={syncMutation.isPending}
        onConfirm={() => { syncMutation.mutate({ reset_cursor: true }); setConfirmForceResync(false) }}
        onCancel={() => setConfirmForceResync(false)}
      />
    </div>
  )
}
