import { useEffect } from 'react'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  width?: string
}

export default function Modal({ open, onClose, title, children, width = 'max-w-md' }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={`relative bg-white rounded-2xl shadow-xl w-full ${width} max-h-[90vh] flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900 text-sm">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

// ─── Shared form primitives ───────────────────────────────────────────────────

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3.5">
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}

export const inputCls =
  'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent'

export function ModalActions({ onCancel, submitLabel, loading, disabled }: {
  onCancel: () => void
  submitLabel: string
  loading?: boolean
  disabled?: boolean
}) {
  return (
    <div className="flex gap-2 justify-end mt-5 pt-4 border-t border-gray-100">
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={loading || disabled}
        className="px-4 py-2 text-sm font-medium bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 transition-colors"
      >
        {loading ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}
