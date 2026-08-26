import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link'
import type { PlaidItem } from '../lib/types'
import {
  plaidCreateLinkToken,
  plaidExchangeToken,
  plaidSyncTransactions,
} from '../lib/mutations'
import type { PlaidExchangeResult } from '../lib/mutations'
import BankConnectionsSection from './settings/BankConnectionsSection'
import CustomCategoriesList from '../components/CustomCategoriesList'
import ShortcutsSettingsCard from '../components/ShortcutsSettingsCard'
import DuplicateConnectionModal from '../components/modals/DuplicateConnectionModal'

type DuplicateInfo = Extract<PlaidExchangeResult, { status: 'duplicate_detected' }>

export default function SettingsPage() {
  const qc = useQueryClient()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  // item_id of the item being reconnected in update mode (undefined = create mode)
  const [reconnectItemId, setReconnectItemId] = useState<string | undefined>()
  // Held across the duplicate modal — public_token has a 30-min Plaid expiry
  const [pendingPublicToken, setPendingPublicToken] = useState<string | null>(null)
  const [pendingMetadata, setPendingMetadata] = useState<PlaidLinkOnSuccessMetadata | null>(null)
  const [duplicateInfo, setDuplicateInfo] = useState<DuplicateInfo | null>(null)
  const plaidEnv = import.meta.env.VITE_PLAID_ENV as string | undefined

  function invalidatePlaid() {
    qc.invalidateQueries({ queryKey: ['plaid_items'] })
    qc.invalidateQueries({ queryKey: ['plaid_accounts'] })
    qc.invalidateQueries({ queryKey: ['transactions'] })
  }

  // First call: detect duplicates or exchange directly if no duplicate.
  const exchangeTokenMutation = useMutation({
    mutationFn: (params: Parameters<typeof plaidExchangeToken>[0]) =>
      plaidExchangeToken(params),
    onSuccess: (result) => {
      if ('status' in result && result.status === 'duplicate_detected') {
        // Hold here — client shows modal, sends follow-up choice call.
        setDuplicateInfo(result as DuplicateInfo)
        return
      }
      if ('warning' in result && result.warning === 'login_required') {
        setLinkError(
          'Existing connection needs re-authentication — use the Reconnect button.'
        )
      }
      invalidatePlaid()
      setReconnectItemId(undefined)
    },
    onError: (e: Error) => setLinkError(e.message),
  })

  // Second call: user's keep/fresh choice after duplicate detected.
  const choiceMutation = useMutation({
    mutationFn: (choice: 'keep' | 'fresh') =>
      plaidExchangeToken({
        public_token: pendingPublicToken!,
        metadata: pendingMetadata,
        mode: 'create',
        choice,
        existing_item_id: duplicateInfo!.existing_item_id,
      }),
    onSuccess: (result, choice) => {
      // Capture before clearing state
      const keptItemId = duplicateInfo?.existing_item_id
      setDuplicateInfo(null)
      setPendingPublicToken(null)
      setPendingMetadata(null)

      if ('warning' in result && result.warning === 'login_required') {
        setLinkError(
          'Existing connection needs re-authentication — use the Reconnect button.'
        )
      }
      // Trigger sync on kept item so new transactions appear without manual Sync Now.
      if (choice === 'keep' && keptItemId) {
        plaidSyncTransactions({ item_id: keptItemId }).catch(() => {})
      }
      invalidatePlaid()
    },
    onError: (e: Error) => {
      setLinkError(e.message)
      setDuplicateInfo(null)
      setPendingPublicToken(null)
      setPendingMetadata(null)
    },
  })

  const createTokenMutation = useMutation({
    mutationFn: (itemId?: string) => plaidCreateLinkToken(itemId),
    onSuccess: ({ link_token }) => setLinkToken(link_token),
    onError: (e: Error) => setLinkError(e.message),
  })

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (public_token, metadata) => {
      setLinkToken(null)
      if (reconnectItemId) {
        // Update mode — re-authenticating an existing item; skip duplicate detection.
        exchangeTokenMutation.mutate({
          public_token,
          mode: 'update',
          item_id: reconnectItemId,
        })
        setReconnectItemId(undefined)
      } else {
        // Create mode — check for duplicates before exchanging.
        setPendingPublicToken(public_token)
        setPendingMetadata(metadata)
        exchangeTokenMutation.mutate({ public_token, metadata, mode: 'create' })
      }
    },
    onExit: (err) => {
      if (err)
        setLinkError(
          `Plaid Link closed with an error: ${err.error_message ?? err.error_code}`
        )
      setLinkToken(null)
    },
  })

  useEffect(() => {
    if (linkToken && ready) open()
  }, [linkToken, ready, open])

  function handleConnect() {
    setLinkError(null)
    setReconnectItemId(undefined)
    createTokenMutation.mutate(undefined)
  }

  function handleReconnect(item: PlaidItem) {
    setLinkError(null)
    setReconnectItemId(item.item_id)
    createTokenMutation.mutate(item.item_id)
  }

  const busy =
    createTokenMutation.isPending ||
    exchangeTokenMutation.isPending ||
    choiceMutation.isPending

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-10">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage bank connections and custom categories
        </p>
      </header>

      <BankConnectionsSection
        onConnect={handleConnect}
        onReconnect={handleReconnect}
        errorMessage={linkError}
        busy={busy}
      />

      <section className="space-y-3">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Custom Categories</h2>
        </header>
        <div className="border border-gray-200 rounded-lg bg-white p-4">
          <CustomCategoriesList />
        </div>
      </section>

      <ShortcutsSettingsCard />

      {plaidEnv && plaidEnv !== 'production' && (
        <div className="text-xs text-gray-400 text-center pt-6">
          Plaid env: {plaidEnv}
        </div>
      )}

      <DuplicateConnectionModal
        open={duplicateInfo !== null}
        info={duplicateInfo}
        onKeep={() => choiceMutation.mutate('keep')}
        onFresh={() => choiceMutation.mutate('fresh')}
        onCancel={() => {
          setDuplicateInfo(null)
          setPendingPublicToken(null)
          setPendingMetadata(null)
        }}
        isPending={choiceMutation.isPending}
      />
    </div>
  )
}
