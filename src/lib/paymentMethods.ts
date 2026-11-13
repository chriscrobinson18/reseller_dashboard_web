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
  if (value === 'split') return 'Split' // SPLIT_PAYMENT sentinel — see below
  return PAYMENT_METHODS.find(m => m.value === value)?.label ?? value
}

/** Rails that never produce a 1099-K, so their absence from one is expected. */
export function isUnreportedRail(value: string | null | undefined): boolean {
  if (!value) return false
  const def = PAYMENT_METHODS.find(m => m.value === value)
  return def ? !def.reports1099k : false
}

// ─── Split payments ──────────────────────────────────────────────────────────
//
// Rare (~1 in 500 sales): a buyer pays one order across several rails, e.g.
// $60 cash + $40 Venmo. Stored as a JSON list on `sales.payments` /
// `sale_bundles.payments`, with `payment_method` set to the 'split' sentinel so
// existing pills, filters and search still have one value to read. Null
// `payments` means "one rail, the whole amount" — every pre-existing row.
// Deliberately NOT a child table: at this frequency a JSON column avoids a
// join on every sales read and keeps record/edit/delete code unchanged.

/** Sentinel stored in `payment_method` when `payments` holds the breakdown. */
export const SPLIT_PAYMENT = 'split'

export interface PaymentSplit {
  method: string
  amount: number
}

const toCents = (n: number) => Math.round(n * 100)

/**
 * Validates a split against the amount it must cover (sale price, or bundle
 * total). Compared in whole cents so 33.33 + 33.33 + 33.34 === 100 holds.
 * Returns an error message, or null when valid.
 */
export function validatePaymentSplits(splits: PaymentSplit[], total: number): string | null {
  if (splits.length < 2) return 'A split payment needs at least two methods'
  const seen = new Set<string>()
  for (const s of splits) {
    if (!s.method || s.method === SPLIT_PAYMENT) return 'Choose a method for every payment'
    if (seen.has(s.method)) return 'List each payment method once'
    seen.add(s.method)
    if (!(s.amount > 0)) return 'Every payment amount must be greater than 0'
  }
  const diff = toCents(total) - splits.reduce((sum, s) => sum + toCents(s.amount), 0)
  if (diff !== 0) {
    const abs = (Math.abs(diff) / 100).toFixed(2)
    return diff > 0 ? `Payments are $${abs} short of the sale total` : `Payments exceed the sale total by $${abs}`
  }
  return null
}

/**
 * Normalised per-rail breakdown for a sale or bundle: the stored split when
 * there is one, else the single method covering the full amount. This is what
 * a deposit tie-out / 1099-K reconciliation should read instead of
 * payment_method alone. Empty when no method was recorded.
 */
export function paymentBreakdown(
  paymentMethod: string | null | undefined,
  payments: PaymentSplit[] | null | undefined,
  total: number,
): PaymentSplit[] {
  if (payments && payments.length > 0) return payments
  if (!paymentMethod || paymentMethod === SPLIT_PAYMENT) return []
  return [{ method: paymentMethod, amount: total }]
}

/** "Cash $60.00 + Venmo $40.00" — for detail panels, tooltips and search. */
export function formatPaymentSplits(payments: PaymentSplit[] | null | undefined): string {
  return (payments ?? [])
    .map(p => `${paymentMethodLabel(p.method) ?? p.method} $${p.amount.toFixed(2)}`)
    .join(' + ')
}

/** Split-editor form row: amount kept as the raw input string so typing "12." works. */
export interface SplitRow {
  method: string
  amount: string
}

export const emptySplitRows = (): SplitRow[] => [{ method: '', amount: '' }, { method: '', amount: '' }]

export function splitRowsFrom(payments: PaymentSplit[] | null | undefined): SplitRow[] {
  return payments && payments.length > 0
    ? payments.map(p => ({ method: p.method, amount: String(p.amount) }))
    : emptySplitRows()
}

/** Form rows → stored splits. Blank/invalid amounts become 0 (validation rejects them); rounded to cents. */
export function parseSplitRows(rows: SplitRow[]): PaymentSplit[] {
  return rows.map(r => {
    const n = parseFloat(r.amount)
    return { method: r.method, amount: isNaN(n) ? 0 : Math.round(n * 100) / 100 }
  })
}
