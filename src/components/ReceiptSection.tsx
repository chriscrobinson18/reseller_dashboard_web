import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Paperclip, Trash2, ExternalLink, RefreshCw } from 'lucide-react'
import { uploadReceipt, replaceReceipt, deleteReceipt, getReceiptSignedUrl } from '../lib/mutations'
import ConfirmDialog from './ConfirmDialog'

const MAX_BYTES = 10 * 1024 * 1024 // 10MB
const ACCEPT = 'image/*,application/pdf'

interface Props {
  transactionId: string
  receiptPath: string | null | undefined
}

/**
 * Attach / view / replace / delete a receipt file for a transaction. Files
 * live in the private `receipts` Storage bucket; `transactions.receipt_url`
 * stores the storage path (see docs/supabase-schema.md).
 */
export default function ReceiptSection({ transactionId, receiptPath }: Props) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // 'attach' picks a file for an empty slot; 'replace' swaps out an existing one.
  const [pendingAction, setPendingAction] = useState<'attach' | 'replace'>('attach')

  const invalidate = () => qc.invalidateQueries({ queryKey: ['transactions'] })

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadReceipt(transactionId, file),
    onSuccess: invalidate,
    onError: (e: Error) => setError(e.message),
  })

  const replaceMutation = useMutation({
    mutationFn: (file: File) => replaceReceipt(transactionId, receiptPath!, file),
    onSuccess: invalidate,
    onError: (e: Error) => setError(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteReceipt(transactionId, receiptPath!),
    onSuccess: () => { invalidate(); setConfirmDelete(false) },
    onError: (e: Error) => setError(e.message),
  })

  const viewMutation = useMutation({
    mutationFn: () => getReceiptSignedUrl(receiptPath!),
    onSuccess: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    onError: (e: Error) => setError(e.message),
  })

  function pickFile(action: 'attach' | 'replace') {
    setError(null)
    setPendingAction(action)
    inputRef.current?.click()
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    if (file.size > MAX_BYTES) { setError('File too large — 10MB max.'); return }
    if (pendingAction === 'replace' && receiptPath) {
      replaceMutation.mutate(file)
    } else {
      uploadMutation.mutate(file)
    }
  }

  const busy = uploadMutation.isPending || replaceMutation.isPending || deleteMutation.isPending
  const filename = receiptPath?.split('/').pop() ?? ''

  return (
    <div>
      <div className="text-xs font-medium text-gray-500 mb-1.5">Receipt</div>
      <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={onFileChosen} />

      {receiptPath ? (
        <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
          <Paperclip size={14} className="text-gray-400 shrink-0" />
          <button
            onClick={() => viewMutation.mutate()}
            disabled={viewMutation.isPending}
            className="flex-1 min-w-0 text-left text-sm text-gray-900 truncate hover:underline flex items-center gap-1 disabled:opacity-50"
          >
            <span className="truncate">{viewMutation.isPending ? 'Opening…' : filename}</span>
            <ExternalLink size={11} className="text-gray-400 shrink-0" />
          </button>
          <button
            onClick={() => pickFile('replace')}
            disabled={busy}
            title="Replace"
            className="text-gray-400 hover:text-gray-700 p-1 disabled:opacity-40"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            title="Delete"
            className="text-gray-400 hover:text-red-500 p-1 disabled:opacity-40"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => pickFile('attach')}
          disabled={busy}
          className="w-full flex items-center justify-center gap-1.5 border border-dashed border-gray-300 rounded-lg py-2 text-sm text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors disabled:opacity-50"
        >
          <Paperclip size={13} /> {uploadMutation.isPending ? 'Uploading…' : 'Attach receipt'}
        </button>
      )}

      {replaceMutation.isPending && <div className="text-xs text-gray-400 mt-1">Replacing…</div>}
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete receipt?"
        message="This permanently removes the attached file."
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
