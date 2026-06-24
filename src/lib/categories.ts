export interface CategoryDef {
  value: string
  label: string
  color: string
  bgColor: string
  isExcluded: boolean
  mealsHalf?: boolean
  scheduleLine?: string
}

export const CATEGORIES: CategoryDef[] = [
  // Non-Schedule-C
  { value: 'transfer', label: 'Transfer', color: '#6b7280', bgColor: '#f3f4f6', isExcluded: true },
  { value: 'personal', label: 'Personal', color: '#9ca3af', bgColor: '#f9fafb', isExcluded: true },
  { value: 'settlement', label: 'Settlement', color: '#7c3aed', bgColor: '#ede9fe', isExcluded: true },
  { value: 'balance_adjustment', label: 'Balance Adjustment', color: '#8b5cf6', bgColor: '#ede9fe', isExcluded: true },
  // Part I
  { value: 'payout', label: 'Payout / Income', color: '#059669', bgColor: '#d1fae5', isExcluded: false, scheduleLine: 'Part I' },
  { value: 'returns_allowances', label: 'Returns & Allowances', color: '#dc2626', bgColor: '#fee2e2', isExcluded: false, scheduleLine: 'Part I' },
  // Part III
  { value: 'cost_of_goods', label: 'Cost of Goods', color: '#d97706', bgColor: '#fef3c7', isExcluded: false, scheduleLine: 'Part III' },
  // Part II
  { value: 'advertising', label: 'Advertising', color: '#db2777', bgColor: '#fce7f3', isExcluded: false, scheduleLine: 'Line 8' },
  { value: 'car_truck', label: 'Car & Truck', color: '#2563eb', bgColor: '#dbeafe', isExcluded: false, scheduleLine: 'Line 9' },
  { value: 'commissions_fees', label: 'Commissions & Fees', color: '#dc2626', bgColor: '#fee2e2', isExcluded: false, scheduleLine: 'Line 10' },
  { value: 'contract_labor', label: 'Contract Labor', color: '#7c3aed', bgColor: '#ede9fe', isExcluded: false, scheduleLine: 'Line 11' },
  { value: 'depreciation', label: 'Depreciation', color: '#9ca3af', bgColor: '#f3f4f6', isExcluded: false, scheduleLine: 'Line 13' },
  { value: 'insurance', label: 'Insurance', color: '#0891b2', bgColor: '#cffafe', isExcluded: false, scheduleLine: 'Line 15' },
  { value: 'interest_expense', label: 'Interest Expense', color: '#dc2626', bgColor: '#fee2e2', isExcluded: false, scheduleLine: 'Line 16' },
  { value: 'legal_professional', label: 'Legal & Professional', color: '#7c3aed', bgColor: '#ede9fe', isExcluded: false, scheduleLine: 'Line 17' },
  { value: 'office_expense', label: 'Office Expense', color: '#4f46e5', bgColor: '#eef2ff', isExcluded: false, scheduleLine: 'Line 18' },
  { value: 'rent_lease', label: 'Rent or Lease', color: '#ea580c', bgColor: '#ffedd5', isExcluded: false, scheduleLine: 'Line 20b' },
  { value: 'repairs_maintenance', label: 'Repairs & Maint.', color: '#ea580c', bgColor: '#ffedd5', isExcluded: false, scheduleLine: 'Line 21' },
  { value: 'supplies', label: 'Supplies', color: '#65a30d', bgColor: '#ecfccb', isExcluded: false, scheduleLine: 'Line 22' },
  { value: 'taxes_licenses', label: 'Taxes & Licenses', color: '#0d9488', bgColor: '#ccfbf1', isExcluded: false, scheduleLine: 'Line 23' },
  { value: 'travel', label: 'Travel', color: '#0284c7', bgColor: '#e0f2fe', isExcluded: false, scheduleLine: 'Line 24a' },
  { value: 'meals', label: 'Meals (50%)', color: '#d97706', bgColor: '#fef3c7', isExcluded: false, scheduleLine: 'Line 24b', mealsHalf: true },
  { value: 'utilities', label: 'Utilities', color: '#6b7280', bgColor: '#f3f4f6', isExcluded: false, scheduleLine: 'Line 25' },
  { value: 'shipping_postage', label: 'Shipping & Postage', color: '#0284c7', bgColor: '#e0f2fe', isExcluded: false, scheduleLine: 'Line 27a' },
  { value: 'other_expense', label: 'Other Expense', color: '#6b7280', bgColor: '#f3f4f6', isExcluded: false, scheduleLine: 'Line 27a' },
  { value: 'home_office', label: 'Home Office', color: '#059669', bgColor: '#d1fae5', isExcluded: false, scheduleLine: 'Line 30' },
]

export function getCategoryDef(value?: string | null): CategoryDef | undefined {
  if (!value) return undefined
  return CATEGORIES.find(c => c.value === value)
}

import type { Transaction } from './types'

export type ScheduleCBucket = 'income' | 'expense' | 'cogs' | null

export interface BucketedAmount {
  bucket: ScheduleCBucket
  categoryValue: string | null
  signedAmount: number
}

/**
 * Single source of truth for "does this transaction count toward Schedule C, and if so where?"
 *
 * Returns SIGNED amounts (a refund posted to an expense category comes back as positive,
 * which correctly offsets the negative expense amounts when summed). Callers should sum
 * signedAmount per categoryValue and only abs() at display time.
 *
 * Future work: when custom_categories ships, this function already handles arbitrary
 * categoryValue strings — it's the dashboard display code (CATEGORIES.filter) that
 * needs to become data-driven. See docs/categories.md "Custom categories".
 */
export function bucketTransaction(t: Transaction): BucketedAmount {
  const none: BucketedAmount = { bucket: null, categoryValue: null, signedAmount: 0 }

  if (t.record_type === 'settlement') return none
  if (t.related_sale_id) return none
  if (t.source === 'csv_import') return none
  if (t.net_zero_pair_id) return none
  if (!t.schedule_c_category) return none

  const cat = getCategoryDef(t.schedule_c_category)
  if (cat?.isExcluded) return none

  const mult = cat?.mealsHalf ? 0.5 : 1
  const signed = t.amount * mult

  if (cat?.scheduleLine === 'Part I') {
    return { bucket: 'income', categoryValue: t.schedule_c_category, signedAmount: signed }
  }
  if (cat?.scheduleLine === 'Part III') {
    return { bucket: 'cogs', categoryValue: t.schedule_c_category, signedAmount: signed }
  }
  return { bucket: 'expense', categoryValue: t.schedule_c_category, signedAmount: signed }
}
