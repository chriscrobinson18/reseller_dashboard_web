import { useEffect, useRef, useState } from 'react'
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
import { importMarketplaceCSV, syncCSVOrders } from '../lib/mutations'
import type { CSVImportResult, CSVSaleSyncResult } from '../lib/types'
import { useCSVGroups, isLinkedGroup, getExpectedDeposit } from '../lib/queries'
import CSVGroupDetailSlideOver from '../components/CSVGroupDetailSlideOver'
import type { CSVGroup } from '../lib/types'
import ReturnReconciliationSection from '../components/ReturnReconciliationSection'

type DuplicateInfo = Extract<PlaidExchangeResult, { status: 'duplicate_detected' }>

type ImportState =
  | { phase: 'idle' }
  | { phase: 'importing' }
  | { phase: 'syncing'; importResult: CSVImportResult }
  | { phase: 'done'; importResult: CSVImportResult; syncResult: CSVSaleSyncResult }
  | { phase: 'error'; message: string }

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

  const [settlementPlatform, setSettlementPlatform] = useState<'ebay' | 'amazon'>('ebay')
  const { data: csvGroups = [], isLoading: groupsLoading } = useCSVGroups(settlementPlatform)
  const [selectedGroup, setSelectedGroup] = useState<CSVGroup | null>(null)

  const [ebayState, setEbayState] = useState<ImportState>({ phase: 'idle' })
  const [amazonState, setAmazonState] = useState<ImportState>({ phase: 'idle' })
  const [mercariState, setMercariState] = useState<ImportState>({ phase: 'idle' })

  const ebayRef = useRef<HTMLInputElement>(null)
  const amazonRef = useRef<HTMLInputElement>(null)
  const mercariRef = useRef<HTMLInputElement>(null)

  async function handleImport(
    platform: string,
    file: File,
    setState: (s: ImportState) => void,
  ) {
    setState({ phase: 'importing' })
    try {
      const importResult = await importMarketplaceCSV(platform, file)
      setState({ phase: 'syncing', importResult })
      const syncResult = await syncCSVOrders(platform)
      setState({ phase: 'done', importResult, syncResult })
      qc.invalidateQueries({ queryKey: ['csv-groups', platform] })
      qc.invalidateQueries({ queryKey: ['sales'] })
    } catch (e: unknown) {
      setState({ phase: 'error', message: e instanceof Error ? e.message : 'Import failed' })
    }
  }

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

  const [activeTab, setActiveTab] = useState<'banks' | 'imports' | 'categories'>('banks')

  const TABS = [
    { id: 'banks', label: 'Banks' },
    { id: 'imports', label: 'Imports' },
    { id: 'categories', label: 'Categories' },
  ] as const

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>
      </header>

      {/* Tab strip */}
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'banks' && (
        <>
          <BankConnectionsSection
            onConnect={handleConnect}
            onReconnect={handleReconnect}
            errorMessage={linkError}
            busy={busy}
          />
          <ShortcutsSettingsCard />
        </>
      )}

      {activeTab === 'categories' && (
        <section className="space-y-3">
          <div className="border border-gray-200 rounded-lg bg-white p-4">
            <CustomCategoriesList />
          </div>
        </section>
      )}

      {activeTab === 'imports' && (
        <>
      {/* ── CSV Import ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Marketplace CSV Import</h2>
        </div>
        <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
          <CSVImportCard
            platform="ebay"
            label="eBay"
            description="Seller Hub → Payments → Transaction Report"
            state={ebayState}
            inputRef={ebayRef}
            onPick={() => ebayRef.current?.click()}
            onFile={file => handleImport('ebay', file, setEbayState)}
            onReset={() => setEbayState({ phase: 'idle' })}
          />
          <CSVImportCard
            platform="amazon"
            label="Amazon"
            description="Seller Central → Reports → Payments → Transaction View"
            state={amazonState}
            inputRef={amazonRef}
            onPick={() => amazonRef.current?.click()}
            onFile={file => handleImport('amazon', file, setAmazonState)}
            onReset={() => setAmazonState({ phase: 'idle' })}
          />
          <CSVImportCard
            platform="mercari"
            label="Mercari"
            description="Profile → My Sales → Download"
            state={mercariState}
            inputRef={mercariRef}
            onPick={() => mercariRef.current?.click()}
            onFile={file => handleImport('mercari', file, setMercariState)}
            onReset={() => setMercariState({ phase: 'idle' })}
          />
        </div>
      </section>

      {/* ── Settlement Status ──────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Settlement Status</h2>
          {csvGroups.length > 0 && (
            <span className={`text-sm font-medium ${
              csvGroups.filter(isLinkedGroup).length === csvGroups.length
                ? 'text-green-600' : 'text-amber-600'
            }`}>
              {csvGroups.filter(isLinkedGroup).length} of {csvGroups.length} matched
            </span>
          )}
        </div>

        {/* Platform toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden w-fit">
          {(['ebay', 'amazon'] as const).map(p => (
            <button
              key={p}
              type="button"
              onClick={() => setSettlementPlatform(p)}
              className={`px-4 py-1.5 text-sm font-medium ${
                settlementPlatform === p
                  ? 'bg-gray-900 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {p === 'ebay' ? 'eBay' : 'Amazon'}
            </button>
          ))}
        </div>

        {groupsLoading ? (
          <div className="text-sm text-gray-500 py-4 text-center">Loading...</div>
        ) : csvGroups.length === 0 ? (
          <div className="text-sm text-gray-500 py-4 text-center border border-gray-200 rounded-lg bg-white">
            No {settlementPlatform === 'ebay' ? 'eBay' : 'Amazon'} CSV imports found. Import a Transaction Report above.
          </div>
        ) : (
          <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
            {csvGroups.map(g => {
              const expected = getExpectedDeposit(g)
              const linked = isLinkedGroup(g)
              const dates = g.transactions.map(t => t.date).sort()
              const dateMin = dates[0]
              const dateMax = dates[dates.length - 1]

              return (
                <button
                  key={g.groupId}
                  type="button"
                  onClick={() => setSelectedGroup(g)}
                  className="w-full flex items-center gap-3 p-4 hover:bg-gray-50 text-left"
                >
                  {/* Status dot */}
                  <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    linked ? 'bg-green-500' : expected !== undefined ? 'bg-amber-400' : 'bg-gray-300'
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900">
                      {settlementPlatform === 'ebay' ? 'eBay' : 'Amazon'} Payout
                      {dateMin && dateMax && (
                        <span className="font-normal text-gray-500 ml-1">
                          — {new Date(dateMin + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          –{new Date(dateMax + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {expected !== undefined
                        ? `Expected deposit: $${expected.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                        : 'Held in reserve'}
                      {' · '}{g.transactions.length} transactions
                    </div>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    linked
                      ? 'bg-green-100 text-green-700'
                      : expected !== undefined
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-gray-100 text-gray-500'
                  }`}>
                    {linked ? '✓ Matched' : expected !== undefined ? 'Needs Match' : 'On Hold'}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Return Reconciliation ──────────────────────────────── */}
      <ReturnReconciliationSection />

        </>
      )}

      {/* Settlement group detail slide-over */}
      {selectedGroup && (
        <CSVGroupDetailSlideOver
          group={selectedGroup}
          platform={settlementPlatform}
          open={selectedGroup !== null}
          onClose={() => setSelectedGroup(null)}
          onLinked={() => {
            qc.invalidateQueries({ queryKey: ['csv-groups', settlementPlatform] })
            setSelectedGroup(null)
          }}
        />
      )}

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

// ── CSVImportCard ─────────────────────────────────────────────────────────────

type CSVImportCardProps = {
  platform: string
  label: string
  description: string
  state: ImportState
  inputRef: React.RefObject<HTMLInputElement | null>
  onPick: () => void
  onFile: (file: File) => void
  onReset: () => void
}

function CSVImportCard({ platform: _platform, label, description, state, inputRef, onPick, onFile, onReset }: CSVImportCardProps) {
  const busy = state.phase === 'importing' || state.phase === 'syncing'

  return (
    <div className="p-4 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 text-sm">{label}</div>
        <div className="text-xs text-gray-500 mt-0.5">{description}</div>

        {/* Result banner */}
        {(state.phase === 'syncing' || state.phase === 'done') && (
          <div className="mt-2 p-2.5 bg-green-50 border border-green-200 rounded-lg text-xs space-y-1">
            <div className="text-green-800 font-medium">
              {label} import complete — {state.importResult.rows_parsed} rows imported
              {state.importResult.rows_skipped > 0 && `, ${state.importResult.rows_skipped} skipped`}
              {state.importResult.amazon_format && (
                <span className="ml-1 text-green-600">
                  ({state.importResult.amazon_format.replace('_', ' ')})
                </span>
              )}
            </div>
            {state.phase === 'syncing' && (
              <div className="text-green-700 flex items-center gap-1.5">
                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Syncing sales...
              </div>
            )}
            {state.phase === 'done' && (
              <div className="text-green-700">
                {state.syncResult.created > 0 && `${state.syncResult.created} orders added to Sales`}
                {state.syncResult.created > 0 && state.syncResult.updated > 0 && ', '}
                {state.syncResult.updated > 0 && `${state.syncResult.updated} updated`}
                {state.syncResult.created === 0 && state.syncResult.updated === 0 && 'Sales already up to date'}
              </div>
            )}
          </div>
        )}

        {state.phase === 'error' && (
          <div className="mt-2 p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
            {state.message}
            <button type="button" onClick={onReset} className="ml-2 underline">Dismiss</button>
          </div>
        )}
      </div>

      <div className="flex-shrink-0">
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) { onFile(file); e.target.value = '' }
          }}
        />
        <button
          type="button"
          onClick={onPick}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? (state.phase === 'importing' ? 'Importing...' : 'Syncing...') : 'Import CSV'}
        </button>
      </div>
    </div>
  )
}
