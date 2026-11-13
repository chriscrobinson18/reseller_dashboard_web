import { describe, it, expect } from 'vitest'
import {
  validatePaymentSplits,
  paymentBreakdown,
  parseSplitRows,
  formatPaymentSplits,
  paymentMethodLabel,
  SPLIT_PAYMENT,
} from '../paymentMethods'

describe('validatePaymentSplits', () => {
  it('accepts splits that sum exactly to the total', () => {
    expect(validatePaymentSplits([{ method: 'cash', amount: 60 }, { method: 'venmo', amount: 40 }], 100)).toBeNull()
  })

  it('compares in cents, so float drift does not reject a valid split', () => {
    // 0.1 + 0.2 !== 0.3 in floating point
    expect(validatePaymentSplits([{ method: 'cash', amount: 0.1 }, { method: 'venmo', amount: 0.2 }], 0.3)).toBeNull()
    expect(validatePaymentSplits([
      { method: 'cash', amount: 33.33 }, { method: 'venmo', amount: 33.33 }, { method: 'zelle', amount: 33.34 },
    ], 100)).toBeNull()
  })

  it('reports a shortfall and an overage with the cent difference', () => {
    expect(validatePaymentSplits([{ method: 'cash', amount: 60 }, { method: 'venmo', amount: 39.5 }], 100))
      .toBe('Payments are $0.50 short of the sale total')
    expect(validatePaymentSplits([{ method: 'cash', amount: 60 }, { method: 'venmo', amount: 41 }], 100))
      .toBe('Payments exceed the sale total by $1.00')
  })

  it('rejects fewer than two payments, blank/sentinel methods, duplicates and non-positive amounts', () => {
    expect(validatePaymentSplits([{ method: 'cash', amount: 100 }], 100)).toMatch(/at least two/)
    expect(validatePaymentSplits([{ method: '', amount: 50 }, { method: 'cash', amount: 50 }], 100)).toMatch(/Choose a method/)
    expect(validatePaymentSplits([{ method: SPLIT_PAYMENT, amount: 50 }, { method: 'cash', amount: 50 }], 100)).toMatch(/Choose a method/)
    expect(validatePaymentSplits([{ method: 'cash', amount: 50 }, { method: 'cash', amount: 50 }], 100)).toMatch(/once/)
    expect(validatePaymentSplits([{ method: 'cash', amount: 100 }, { method: 'venmo', amount: 0 }], 100)).toMatch(/greater than 0/)
  })
})

describe('paymentBreakdown', () => {
  it('returns the stored split when present', () => {
    const split = [{ method: 'cash', amount: 60 }, { method: 'venmo', amount: 40 }]
    expect(paymentBreakdown(SPLIT_PAYMENT, split, 100)).toEqual(split)
  })

  it('treats a single method as covering the whole amount', () => {
    expect(paymentBreakdown('venmo', null, 100)).toEqual([{ method: 'venmo', amount: 100 }])
  })

  it('is empty when nothing usable is recorded (incl. a bundle line holding only the sentinel)', () => {
    expect(paymentBreakdown(null, null, 100)).toEqual([])
    expect(paymentBreakdown(SPLIT_PAYMENT, null, 100)).toEqual([])
  })
})

describe('parseSplitRows / formatting', () => {
  it('rounds to cents and maps blanks to 0', () => {
    expect(parseSplitRows([{ method: 'cash', amount: '60.004' }, { method: 'venmo', amount: '' }]))
      .toEqual([{ method: 'cash', amount: 60 }, { method: 'venmo', amount: 0 }])
  })

  it('labels the sentinel and formats a breakdown', () => {
    expect(paymentMethodLabel(SPLIT_PAYMENT)).toBe('Split')
    expect(formatPaymentSplits([{ method: 'cash', amount: 60 }, { method: 'cashapp', amount: 40 }]))
      .toBe('Cash $60.00 + Cash App $40.00')
  })
})
