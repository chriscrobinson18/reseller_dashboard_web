import { useEffect } from 'react'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  width?: string
}

export default function SlideOver({ open, onClose, title, children, width = 'w-[460px]' }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex h-dvh">
      {/* backdrop */}
      <div className="flex-1 bg-black/20" onClick={onClose} />
      {/* panel */}
      <div className={`${width} max-w-full min-w-0 bg-white shadow-xl flex flex-col`}>
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 sm:py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900 text-sm min-w-0 truncate">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1.5 -mr-1.5 rounded shrink-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-5 pb-safe-plus">
          {children}
        </div>
      </div>
    </div>
  )
}
