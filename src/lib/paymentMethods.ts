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
