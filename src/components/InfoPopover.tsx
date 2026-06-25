import { useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'

interface Props {
  children: React.ReactNode
  label?: string
  width?: string
}

/**
 * Click-to-open popover anchored to an Info icon trigger. Closes on Escape,
 * outside click, or re-click of the trigger.
 *
 * Renders panel with z-[60] so it sits above z-50 Modal it may live inside.
 */
export default function InfoPopover({ children, label = 'More info', width = 'w-80' }: Props) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  return (
    <span ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={label}
        aria-expanded={open}
        className="text-gray-400 hover:text-gray-700 p-1 rounded inline-flex items-center"
      >
        <Info size={14} />
      </button>
      {open && (
        <div
          className={`absolute right-0 top-full mt-1 ${width} bg-white border border-gray-200 rounded-lg shadow-lg p-4 text-xs text-gray-700 max-h-[400px] overflow-y-auto z-[60]`}
          role="dialog"
          aria-label={label}
        >
          {children}
        </div>
      )}
    </span>
  )
}
