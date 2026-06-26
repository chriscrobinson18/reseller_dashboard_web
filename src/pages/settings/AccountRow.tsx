import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Check, X } from 'lucide-react'
import type { PlaidAccount } from '../../lib/types'
import { updatePlaidAccount } from '../../lib/mutations'

export default function AccountRow({ account }: { account: PlaidAccount }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(account.display_name ?? account.name ?? '')

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      updatePlaidAccount(account.id, { display_name: name.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaid_accounts', account.item_id] })
      setEditing(false)
    },
  })

  const syncToggleMutation = useMutation({
    mutationFn: (next: boolean) => updatePlaidAccount(account.id, { sync_enabled: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaid_accounts', account.item_id] })
    },
  })

  const displayName = account.display_name ?? account.name ?? '(unnamed account)'

  return (
    <li className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-gray-50">
      {editing ? (
        <>
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') renameMutation.mutate(draft)
              if (e.key === 'Escape') { setDraft(account.display_name ?? account.name ?? ''); setEditing(false) }
            }}
            className="flex-1 min-w-0 text-sm border border-gray-300 rounded px-2 py-1"
          />
          <button
            type="button"
            onClick={() => renameMutation.mutate(draft)}
            disabled={renameMutation.isPending}
            className="p-1 text-green-600 hover:text-green-700 disabled:opacity-40"
            aria-label="Save"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={() => { setDraft(account.display_name ?? account.name ?? ''); setEditing(false) }}
            className="p-1 text-gray-400 hover:text-gray-600"
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <>
          <span className="text-sm text-gray-900 min-w-0 truncate flex-1">
            {displayName}
            {account.mask && <span className="text-gray-400 ml-1">•• {account.mask}</span>}
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="p-1 text-gray-400 hover:text-gray-700"
            aria-label="Rename"
          >
            <Pencil size={12} />
          </button>
          {account.subtype && (
            <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded capitalize">
              {account.subtype}
            </span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={account.sync_enabled}
              disabled={syncToggleMutation.isPending}
              onChange={e => syncToggleMutation.mutate(e.target.checked)}
              className="h-4 w-4"
            />
            Sync
          </label>
        </>
      )}
      {renameMutation.isError && (
        <span className="text-xs text-red-600 ml-2">
          {(renameMutation.error as Error).message}
        </span>
      )}
    </li>
  )
}
