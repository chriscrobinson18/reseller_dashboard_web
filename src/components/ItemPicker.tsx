import { useState, useMemo } from 'react'
import { Search, Package } from 'lucide-react'
import { useItems, itemUnitsInStock, type ItemWithLots } from '../lib/queries'

interface Props {
  selectedId: string | null
  onSelect: (item: ItemWithLots) => void
  filter?: (item: ItemWithLots) => boolean
  onCreateNew?: () => void                   // when provided, shows "+ Create new item" button at the top
  createNewLabel?: string                    // defaults to "Create new item"
}

/** Searchable inventory item list. Shows units in stock so the user can avoid overselling. */
export default function ItemPicker({ selectedId, onSelect, filter, onCreateNew, createNewLabel = 'Create new item' }: Props) {
  const { data: items = [], isLoading } = useItems()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const base = filter ? items.filter(filter) : items
    if (!search) return base
    const q = search.toLowerCase()
    return base.filter(i => i.name.toLowerCase().includes(q) || (i.category ?? '').toLowerCase().includes(q))
  }, [items, search, filter])

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="relative border-b border-gray-100">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search items…"
          className="w-full pl-8 pr-3 py-2 text-sm focus:outline-none"
        />
      </div>
      <div className="max-h-52 overflow-y-auto">
        {onCreateNew && (
          <button
            type="button"
            onClick={onCreateNew}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-50 transition-colors border-b border-gray-100"
          >
            <div className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
              <span className="text-blue-600 text-sm">+</span>
            </div>
            <div className="flex-1 min-w-0 text-sm font-medium text-blue-700">{createNewLabel}</div>
          </button>
        )}
        {isLoading ? (
          <div className="p-4 text-center text-xs text-gray-400">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-gray-400">
            {items.length === 0
                ? 'No items yet — add one from the Inventory tab.'
                : search
                  ? 'No matches.'
                  : 'No items match the current filter.'}
          </div>
        ) : (
          filtered.map(item => {
            const stock = itemUnitsInStock(item)
            const selected = item.id === selectedId
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-50 transition-colors ${
                  selected ? 'bg-blue-50' : ''
                }`}
              >
                <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                  <Package size={13} className="text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{item.name}</div>
                  {item.category && <div className="text-xs text-gray-400">{item.category}</div>}
                </div>
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded shrink-0 ${
                  stock === 0 ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'
                }`}>
                  {stock} in stock
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
