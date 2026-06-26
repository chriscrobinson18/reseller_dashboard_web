import { Building2, Plus } from 'lucide-react'
import type { PlaidItem } from '../../lib/types'
import { usePlaidItems } from '../../lib/queries'
import BankItemCard from './BankItemCard'

interface Props {
  /** Triggered by both the header "Connect Bank" button and the empty-state button. */
  onConnect: () => void
  /** Triggered by an item's "Reconnect" button — parent launches Plaid Link in update mode. */
  onReconnect: (item: PlaidItem) => void
  /** Optional inline error (e.g. from a link-token fetch failure in the parent). */
  errorMessage?: string | null
  /** True when the link-token fetch / exchange is in flight in the parent. */
  busy?: boolean
}

export default function BankConnectionsSection({ onConnect, onReconnect, errorMessage, busy }: Props) {
  const itemsQuery = usePlaidItems()
  const items = itemsQuery.data ?? []

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 size={18} className="text-gray-500" />
          <h2 className="text-lg font-semibold text-gray-900">
            Bank Connections
            {items.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">({items.length})</span>
            )}
          </h2>
        </div>
        <button
          type="button"
          onClick={onConnect}
          disabled={busy}
          className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors disabled:opacity-50"
        >
          <Plus size={14} /> Connect Bank
        </button>
      </header>

      {errorMessage && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {errorMessage}
        </div>
      )}

      {itemsQuery.isPending && (
        <div className="space-y-2">
          <div className="h-20 bg-gray-100 rounded-lg animate-pulse" />
          <div className="h-20 bg-gray-100 rounded-lg animate-pulse" />
        </div>
      )}

      {itemsQuery.isError && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-3">
          Couldn't load bank connections. {(itemsQuery.error as Error).message}
        </div>
      )}

      {!itemsQuery.isPending && items.length === 0 && (
        <div className="text-center py-12 border border-dashed border-gray-200 rounded-lg">
          <Building2 size={28} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-600 mb-3">
            Connect your first bank to start auto-importing transactions.
          </p>
          <button
            type="button"
            onClick={onConnect}
            disabled={busy}
            className="inline-flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            <Plus size={14} /> Connect Bank
          </button>
        </div>
      )}

      {items.map(item => (
        <BankItemCard key={item.id} item={item} onReconnect={() => onReconnect(item)} />
      ))}
    </section>
  )
}
