export function formatUSD(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatMonthYear(dateStr: string): string {
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

export function monthKey(dateStr: string): string {
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr + 'T12:00:00')
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function clsx(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ')
}
