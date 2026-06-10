import { getCategoryDef } from '../lib/categories'

interface Props {
  value?: string | null
  onClick?: (e: React.MouseEvent) => void
  size?: 'sm' | 'xs'
}

export default function CategoryBadge({ value, onClick, size = 'sm' }: Props) {
  const def = getCategoryDef(value)
  const label = def?.label ?? (value ? value : '—')
  const style = def
    ? { color: def.color, backgroundColor: def.bgColor }
    : { color: '#9ca3af', backgroundColor: '#f3f4f6' }

  const cls = size === 'xs'
    ? 'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium'
    : 'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium'

  return (
    <span
      className={cls + (onClick ? ' cursor-pointer hover:opacity-80' : '')}
      style={style}
      onClick={onClick}
    >
      {label}
    </span>
  )
}
