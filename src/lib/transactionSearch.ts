import { resolveCategory, type CustomCategory } from './categories'
import { formatUSD, formatDate } from './utils'
import type { Transaction } from './types'

/**
 * Flattens every user-visible detail of a transaction into one lowercase string
 * for substring matching, so a search box covers anything a row or detail panel
 * can show — not just merchant/notes.
 *
 * Amounts appear in several shapes on purpose: `140.10` (raw), `$140.10`, and
 * `140.1`, so both "140.10" and "$140.10" hit. The sign is dropped — people
 * search the magnitude they saw on the receipt. Dates likewise appear as both
 * ISO (`2026-05-15`) and display (`May 15, 2026`) form.
 */
export function transactionHaystack(t: Transaction, customs: CustomCategory[]): string {
  const abs = Math.abs(t.amount)
  const parts: (string | null | undefined)[] = [
    t.merchant,
    t.notes,
    resolveCategory(t.schedule_c_category, customs)?.label,
    t.schedule_c_category ? undefined : 'uncategorized',
    t.type,
    t.source,
    t.platform,
    t.account_display,
    t.record_type,
    // Amount, in the forms a person is likely to type.
    abs.toFixed(2),
    formatUSD(abs),
    String(abs),
    t.amount < 0 ? 'expense' : 'income',
    // Date, ISO and display.
    t.date,
    formatDate(t.date),
    // Plaid enrichment.
    t.merchant_website,
    t.location_city,
    t.location_region,
    t.payment_channel,
    t.plaid_category,
    t.plaid_category_detailed,
    t.pending ? 'pending' : null,
  ]
  return parts.filter(Boolean).join(' ').toLowerCase()
}

/**
 * Splits a query into terms that must ALL match, so "ebay 140" narrows rather
 * than widening. Currency punctuation is stripped so `$1,234.56` and `1234.56`
 * behave the same.
 */
export function parseSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[$,]/g, ''))
    .filter(Boolean)
}

/** True when every term appears somewhere in the transaction's details. */
export function matchesSearch(t: Transaction, terms: string[], customs: CustomCategory[]): boolean {
  if (terms.length === 0) return true
  const hay = transactionHaystack(t, customs)
  return terms.every(term => hay.includes(term))
}
