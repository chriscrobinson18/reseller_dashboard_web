export type PeriodPreset =
  | 'this_month'
  | 'this_quarter'
  | 'ytd'
  | 'last_month'
  | 'last_quarter'
  | 'last_year'
  | 'all_time'

export interface DateRange {
  start: string | null // 'yyyy-MM-dd'
  end: string | null
}

function toStr(d: Date): string {
  return d.toISOString().split('T')[0]
}

export function getPeriodRange(preset: PeriodPreset): DateRange {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() // 0-indexed

  switch (preset) {
    case 'this_month':
      return { start: toStr(new Date(y, m, 1)), end: toStr(new Date(y, m + 1, 0)) }
    case 'this_quarter': {
      const q = Math.floor(m / 3)
      return { start: toStr(new Date(y, q * 3, 1)), end: toStr(new Date(y, q * 3 + 3, 0)) }
    }
    case 'ytd':
      return { start: toStr(new Date(y, 0, 1)), end: toStr(now) }
    case 'last_month': {
      const lm = m === 0 ? 11 : m - 1
      const ly = m === 0 ? y - 1 : y
      return { start: toStr(new Date(ly, lm, 1)), end: toStr(new Date(ly, lm + 1, 0)) }
    }
    case 'last_quarter': {
      const q = Math.floor(m / 3)
      const pq = q === 0 ? 3 : q - 1
      const py = q === 0 ? y - 1 : y
      return { start: toStr(new Date(py, pq * 3, 1)), end: toStr(new Date(py, pq * 3 + 3, 0)) }
    }
    case 'last_year':
      return { start: toStr(new Date(y - 1, 0, 1)), end: toStr(new Date(y - 1, 11, 31)) }
    case 'all_time':
      return { start: null, end: null }
  }
}

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  this_month: 'This Month',
  this_quarter: 'This Quarter',
  ytd: 'YTD',
  last_month: 'Last Month',
  last_quarter: 'Last Quarter',
  last_year: 'Last Year',
  all_time: 'All Time',
}

export const PERIOD_PRESETS: PeriodPreset[] = [
  'this_month', 'this_quarter', 'ytd',
  'last_month', 'last_quarter', 'last_year', 'all_time',
]
