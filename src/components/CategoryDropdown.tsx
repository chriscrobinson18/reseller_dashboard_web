import { Settings } from 'lucide-react'
import { CATEGORIES } from '../lib/categories'
import { PALETTE } from '../lib/categoryPalette'
import { useCustomCategories, activeCustomCategories } from '../lib/queries'

export const UNCATEGORIZED_SENTINEL = '__uncategorized__'

interface Props {
  /** Currently selected value; for highlighting. */
  current?: string | null
  /** Called with the new value (or null for "clear"). */
  onSelect: (value: string | null) => void
  /** Called when the user clicks the "Manage categories…" footer. */
  onManage: () => void
  /** Hide the "Clear category" row (e.g. when used for an Add modal where empty=uncategorized). */
  hideClear?: boolean
  showUncategorized?: boolean
}

/**
 * Three-section category picker:
 *   ─ Your categories ─    (custom, active only)
 *   ─ Schedule C ─          (built-ins, excluding the 4 isExcluded)
 *   ─ Other ─               (the 4 isExcluded built-ins)
 *   ⚙ Manage categories…    (footer)
 *
 * Caller is responsible for positioning (absolute / floating / inline).
 */
export default function CategoryDropdown({ current, onSelect, onManage, hideClear, showUncategorized }: Props) {
  const { data: allCustoms = [] } = useCustomCategories()
  const customs = activeCustomCategories(allCustoms)

  const scheduleCBuiltIns = CATEGORIES.filter(c => !c.isExcluded)
  const excludedBuiltIns = CATEGORIES.filter(c => c.isExcluded)

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-xl py-1 overflow-y-auto max-h-72 w-64">
      {!hideClear && (
        <div
          className="px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-50 cursor-pointer"
          onClick={() => onSelect(null)}
        >
          — Clear category
        </div>
      )}
      {showUncategorized && (
        <div
          className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-gray-50 flex items-center gap-2 ${current === UNCATEGORIZED_SENTINEL ? 'bg-gray-50 font-medium' : ''}`}
          onClick={() => onSelect(UNCATEGORIZED_SENTINEL)}
        >
          <span className="w-2 h-2 rounded-full shrink-0 bg-gray-300" />
          <span className="text-gray-500 italic">Uncategorized</span>
        </div>
      )}

      {customs.length > 0 && (
        <>
          <SectionHeader label="Your categories" />
          {customs.map(c => {
            const swatch = PALETTE[c.colorKey]
            return (
              <Row
                key={c.value}
                color={swatch.color}
                label={c.name}
                trailing={c.parentValue
                  ? CATEGORIES.find(b => b.value === c.parentValue)?.scheduleLine
                  : c.scheduleLine ?? undefined}
                selected={current === c.value}
                onClick={() => onSelect(c.value)}
              />
            )
          })}
        </>
      )}

      <SectionHeader label="Schedule C" />
      {scheduleCBuiltIns.map(c => (
        <Row
          key={c.value}
          color={c.color}
          label={c.label}
          trailing={c.scheduleLine}
          selected={current === c.value}
          onClick={() => onSelect(c.value)}
        />
      ))}

      <SectionHeader label="Other" />
      {excludedBuiltIns.map(c => (
        <Row
          key={c.value}
          color={c.color}
          label={c.label}
          selected={current === c.value}
          onClick={() => onSelect(c.value)}
        />
      ))}

      <div className="border-t border-gray-100 mt-1 pt-1">
        <div
          className="px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer flex items-center gap-1.5"
          onClick={onManage}
        >
          <Settings size={12} /> Manage categories…
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
      {label}
    </div>
  )
}

function Row({
  color, label, trailing, selected, onClick,
}: {
  color: string; label: string; trailing?: string; selected?: boolean; onClick: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-gray-50 flex items-center gap-2 ${selected ? 'bg-gray-50 font-medium' : ''}`}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <span className="text-gray-700 truncate">{label}</span>
      {trailing && <span className="text-gray-400 ml-auto shrink-0">{trailing}</span>}
    </div>
  )
}
