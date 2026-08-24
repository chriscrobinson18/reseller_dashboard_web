import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import ConfirmDialog from './ConfirmDialog'

async function fetchShortcutToken(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('profiles')
    .select('shortcut_token')
    .eq('id', user.id)
    .maybeSingle()
  return data?.shortcut_token ?? null
}

async function upsertShortcutToken(token: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, shortcut_token: token }, { onConflict: 'id' })
  if (error) throw error
}

export default function ShortcutsSettingsCard() {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const { data: token } = useQuery({
    queryKey: ['shortcut_token'],
    queryFn: fetchShortcutToken,
  })

  const generateMutation = useMutation({
    mutationFn: async () => {
      const newToken = crypto.randomUUID()
      await upsertShortcutToken(newToken)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shortcut_token'] })
      setShowConfirm(false)
    },
  })

  function handleCopy() {
    if (!token) return
    navigator.clipboard.writeText(token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <section className="space-y-3">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Apple Shortcuts</h2>
        </header>
        <div className="border border-gray-200 rounded-lg bg-white p-4 space-y-4">
          <p className="text-sm text-gray-500">
            Record sales and breakdowns quickly from your iPhone. Generate a
            token, copy it, then tap <strong>Add to Shortcuts</strong> and paste
            when prompted on first run.
          </p>

          {!token ? (
            <button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 transition-colors"
            >
              {generateMutation.isPending ? 'Generating…' : 'Generate Token'}
            </button>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded text-xs font-mono text-gray-700 truncate">
                  {token}
                </code>
                <button
                  onClick={handleCopy}
                  className="shrink-0 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="flex gap-2">
                <a
                  href="/reseller-sale.shortcut"
                  download
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                >
                  Add to Shortcuts
                </a>
                <button
                  onClick={() => setShowConfirm(true)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Regenerate
                </button>
              </div>
            </div>
          )}

          {generateMutation.error && (
            <p className="text-sm text-red-600">{String(generateMutation.error)}</p>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={showConfirm}
        title="Regenerate Shortcut Token?"
        message="This will invalidate your current Shortcut. The next time you run it, you'll be prompted to paste your new token."
        confirmLabel="Regenerate"
        loading={generateMutation.isPending}
        onConfirm={() => generateMutation.mutate()}
        onCancel={() => setShowConfirm(false)}
      />
    </>
  )
}
