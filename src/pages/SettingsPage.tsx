import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link'
import type { PlaidItem } from '../lib/types'
import { plaidCreateLinkToken, plaidExchangeToken } from '../lib/mutations'
import BankConnectionsSection from './settings/BankConnectionsSection'
import CustomCategoriesList from '../components/CustomCategoriesList'

export default function SettingsPage() {
  const qc = useQueryClient()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [, setUpdateItemId] = useState<string | undefined>()
  const plaidEnv = import.meta.env.VITE_PLAID_ENV as string | undefined

  const createTokenMutation = useMutation({
    mutationFn: (itemId?: string) => plaidCreateLinkToken(itemId),
    onSuccess: ({ link_token }) => setLinkToken(link_token),
    onError: (e: Error) => setLinkError(e.message),
  })

  const exchangeTokenMutation = useMutation({
    mutationFn: (params: { public_token: string; metadata: PlaidLinkOnSuccessMetadata }) =>
      plaidExchangeToken(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plaid_items'] })
      qc.invalidateQueries({ queryKey: ['plaid_accounts'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      setUpdateItemId(undefined)
    },
    onError: (e: Error) => setLinkError(e.message),
  })

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (public_token, metadata) => {
      exchangeTokenMutation.mutate({ public_token, metadata })
      setLinkToken(null)
    },
    onExit: (err) => {
      if (err) setLinkError(`Plaid Link closed with an error: ${err.error_message ?? err.error_code}`)
      setLinkToken(null)
    },
  })

  useEffect(() => {
    if (linkToken && ready) open()
  }, [linkToken, ready, open])

  function handleConnect() {
    setLinkError(null)
    setUpdateItemId(undefined)
    createTokenMutation.mutate(undefined)
  }

  function handleReconnect(item: PlaidItem) {
    setLinkError(null)
    setUpdateItemId(item.id)
    createTokenMutation.mutate(item.item_id)
  }

  const busy = createTokenMutation.isPending || exchangeTokenMutation.isPending

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

      {plaidEnv && plaidEnv !== 'production' && (
        <div className="text-xs text-gray-400 text-center pt-6">
          Plaid env: {plaidEnv}
        </div>
      )}
    </div>
  )
}
