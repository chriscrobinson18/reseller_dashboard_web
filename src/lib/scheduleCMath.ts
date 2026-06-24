import { bucketTransaction } from './categories'
import type { Transaction } from './types'

/** Sum of signed amounts per Schedule C category. Sum is signed (refunds against expenses reduce expense totals). */
export function computeScheduleC(transactions: Transaction[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const t of transactions) {
    const b = bucketTransaction(t)
    if (b.bucket === null || b.categoryValue === null) continue
    totals[b.categoryValue] = (totals[b.categoryValue] ?? 0) + b.signedAmount
  }
  return totals
}
