import type { LotAdjustmentType } from './types'

/**
 * The kinds of cost that can be capitalized into a lot's basis.
 *
 * All three are direct costs of preparing one identifiable item for sale, which
 * is what makes them inventory cost rather than an expense (ASC 330-10-30-1).
 * The distinction that matters: shipping the card *to the grader* is freight-in
 * and capitalizes; shipping a sold item *to a buyer* is a selling expense and
 * belongs in `shipping_postage` — not here.
 *
 * Kept as a plain list rather than a DB enum for the same reason as
 * paymentMethods.ts: adding a kind shouldn't need a migration. The DB check
 * constraint does bound the values, so extending this list means extending that
 * constraint too.
 */
export const LOT_ADJUSTMENT_TYPES: Array<{
  value: LotAdjustmentType
  label: string
  hint: string
}> = [
  {
    value: 'grading',
    label: 'Grading',
    hint: 'PSA/BGS/SGC fee to grade and slab the card',
  },
  {
    value: 'shipping_to_grader',
    label: 'Shipping to grader',
    hint: 'Postage to send the card out — freight-in, so it capitalizes',
  },
  {
    value: 'other',
    label: 'Other',
    hint: 'Any other direct cost of preparing this item for sale',
  },
]

export const ADJUSTMENT_LABELS: Record<LotAdjustmentType, string> = {
  grading: 'Grading',
  shipping_to_grader: 'Shipping to grader',
  other: 'Cost adjustment',
}

export function adjustmentLabel(type: LotAdjustmentType): string {
  return ADJUSTMENT_LABELS[type] ?? type
}

/** Suggestions only — the field is free text; graders come and go. */
export const KNOWN_GRADERS = ['PSA', 'BGS', 'SGC', 'CGC', 'HGA']
