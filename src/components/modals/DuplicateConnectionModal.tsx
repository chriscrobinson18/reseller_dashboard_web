import Modal from '../Modal'
import type { PlaidExchangeResult } from '../../lib/mutations'

type DuplicateInfo = Extract<PlaidExchangeResult, { status: 'duplicate_detected' }>

interface Props {
  open: boolean
  info: DuplicateInfo | null
  onKeep: () => void
  onFresh: () => void
  onCancel: () => void
  isPending: boolean
}

export default function DuplicateConnectionModal({
  open, info, onKeep, onFresh, onCancel, isPending,
}: Props) {
  if (!info) return null

  return (
    <Modal open={open} onClose={onCancel} title="Account already connected">
      <div className="p-5 space-y-4">
        <p className="text-sm text-gray-700">
          <span className="font-medium">{info.existing_institution_name}</span> is already
          connected with account{info.matched_masks.length > 1 ? 's' : ''}{' '}
          <span className="font-mono font-medium">{info.matched_masks.join(', ')}</span>.
          What would you like to do?
        </p>

        {info.existing_item_status === 'login_required' && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            The existing connection needs re-authentication. If you choose Keep, use the
            Reconnect button to fix it.
          </div>
        )}

        <div className="space-y-2 pt-1">
          <button
            onClick={onKeep}
            disabled={isPending}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Keep existing transactions
          </button>
          <button
            onClick={onFresh}
            disabled={isPending}
            className="w-full rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            Start fresh — delete existing transactions
          </button>
          <button
            onClick={onCancel}
            disabled={isPending}
            className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>

        <p className="text-xs text-gray-400">
          Start fresh permanently deletes all synced transactions for the listed accounts
          and re-imports history from Plaid.
        </p>
      </div>
    </Modal>
  )
}
