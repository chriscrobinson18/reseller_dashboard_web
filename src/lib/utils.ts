// Intl formatters are expensive to construct (tens of µs each) and these run
// for every row of every list, so build each once and reuse it.
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const DATE_LONG = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const DATE_SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' })
const toDate = (dateStr: string) => new Date(dateStr.includes('T') ? dateStr : dateStr + 'T12:00:00')

export function formatUSD(amount: number): string {
  return USD.format(amount)
}

export function formatDate(dateStr: string): string {
  return DATE_LONG.format(toDate(dateStr))
}

export function formatShortDate(dateStr: string): string {
  return DATE_SHORT.format(toDate(dateStr))
}

export function formatMonthYear(dateStr: string): string {
  return MONTH_YEAR.format(toDate(dateStr))
}

export function monthKey(dateStr: string): string {
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T12:00:00')
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Shift-click range selection (Gmail-style). Every selectable id between the
 * anchor (the previously clicked row) and the clicked row, in display order,
 * takes the clicked row's NEW state. Falls back to toggling just the clicked
 * row when there is no anchor or it is no longer in the list (filters changed).
 */
export function selectRange(
  orderedIds: string[],
  current: Set<string>,
  anchorId: string | null,
  clickedId: string,
  isSelectable: (id: string) => boolean = () => true,
): Set<string> {
  const next = new Set(current)
  const select = !current.has(clickedId)
  const a = anchorId === null ? -1 : orderedIds.indexOf(anchorId)
  const b = orderedIds.indexOf(clickedId)
  if (a < 0 || b < 0) {
    if (select) next.add(clickedId)
    else next.delete(clickedId)
    return next
  }
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    const id = orderedIds[i]
    if (!isSelectable(id)) continue
    if (select) next.add(id)
    else next.delete(id)
  }
  return next
}

export function clsx(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ')
}
