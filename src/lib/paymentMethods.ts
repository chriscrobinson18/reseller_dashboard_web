/**
 * How a sale was paid for — orthogonal to `platform`, which is *where* the sale
 * happened. Mainly matters for in-person sales, where there's no marketplace and
 * the rail is the only thing distinguishing one sale from another.
 *
 * `reports1099k` marks rails that issue a 1099-K for goods-and-services volume.
 * Cash and Zelle don't (Zelle is exempt as a bank-to-bank network), so a
 * mismatch between recorded sales and 1099-K totals is expected rather than an
 * error — that flag is what lets a reconciliation view explain the gap.
 */
export interface PaymentMethodDef {
  value: string
  label: string
  reports1099k: boolean
}

export const PAYMENT_METHODS: PaymentMethodDef[] = [
  { value: 'cash', label: 'Cash', reports1099k: false },
  { value: 'venmo', label: 'Venmo', reports1099k: true },
  { value: 'cashapp', label: 'Cash App', reports1099k: true },
  { value: 'paypal', label: 'PayPal', reports1099k: true },
  { value: 'apple_pay', label: 'Apple Pay', reports1099k: false },
  { value: 'zelle', label: 'Zelle', reports1099k: false },
  { value: 'card', label: 'Card', reports1099k: true },
  { value: 'other', label: 'Other', reports1099k: false },
]

export function paymentMethodLabel(value: string | null | undefined): string | null {
  if (!value) return null
  return PAYMENT_METHODS.find(m => m.value === value)?.label ?? value
}

/** Rails that never produce a 1099-K, so their absence from one is expected. */
export function isUnreportedRail(value: string | null | undefined): boolean {
  if (!value) return false
  const def = PAYMENT_METHODS.find(m => m.value === value)
  return def ? !def.reports1099k : false
}

/** One rail + amount entered in a split-payment form (RecordSale/EditSale/EditBundle). */
export interface PaymentSplitInput {
  method: string
  amount: number
}

/**
 * Human-readable summary of a split-tender receipt, e.g. "Cash + PayPal".
 * Null for zero or one rail — those render with the ordinary single-pill badge.
 */
export function paymentSplitsSummary(splits: Array<{ payment_method: string }> | null | undefined): string | null {
  if (!splits || splits.length < 2) return null
  return splits.map(s => paymentMethodLabel(s.payment_method) ?? s.payment_method).join(' + ')
}

/** One editable row in a payment-split form. `amount` stays a string while being typed, like every other numeric form field in this app. */
export interface PaymentSplitRow {
  method: string
  amount: string
}

export const emptyPaymentSplitRow = (): PaymentSplitRow => ({ method: '', amount: '' })

/** Seeds a split-editor's rows from a sale/bundle's persisted payment method(s). */
export function paymentSplitRowsFromSale(
  paymentMethod: string | null | undefined,
  splits: Array<{ payment_method: string; amount: number }> | null | undefined
): PaymentSplitRow[] {
  if (splits && splits.length >= 2) return splits.map(s => ({ method: s.payment_method, amount: String(s.amount) }))
  return [{ method: paymentMethod ?? '', amount: '' }]
}

/**
 * Converts a split editor's rows into mutation params. One filled row
 * collapses to the legacy `paymentMethod` scalar (no amount tracking, same
 * as before this feature existed); two or more becomes a `paymentMethods`
 * split, each with its own amount.
 */
export function resolvePaymentSplits(rows: PaymentSplitRow[]): {
  paymentMethod: string | null
  paymentMethods: PaymentSplitInput[] | null
} {
  const filled = rows.filter(r => r.method)
  if (filled.length <= 1) {
    return { paymentMethod: filled[0]?.method || null, paymentMethods: null }
  }
  return {
    paymentMethod: null,
    paymentMethods: filled.map(r => ({ method: r.method, amount: parseFloat(r.amount) || 0 })),
  }
}

/** Dollar amount not yet assigned to a rail — only meaningful once a sale has 2+ split rows. */
export function paymentSplitsRemaining(rows: PaymentSplitRow[], total: number): number {
  return total - rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
}
