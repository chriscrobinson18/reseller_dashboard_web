import { describe, it, expect } from 'vitest'
import { splitLotCost, tiersTotal, basisFromAdjustments } from '../lotCost'

describe('splitLotCost', () => {
  it('pushes the remainder cent onto the last unit', () => {
    // The motivating case: 3 for $10.00 must not become 3 × $3.33 = $9.99.
    expect(splitLotCost(10, 3)).toEqual([
      { quantity: 2, unitCost: 3.33 },
      { quantity: 1, unitCost: 3.34 },
    ])
  })

  it('returns a single tier when the cost divides evenly', () => {
    expect(splitLotCost(9.99, 3)).toEqual([{ quantity: 3, unitCost: 3.33 }])
    expect(splitLotCost(10, 4)).toEqual([{ quantity: 4, unitCost: 2.5 }])
  })

  it('handles a quantity of one', () => {
    expect(splitLotCost(10, 1)).toEqual([{ quantity: 1, unitCost: 10 }])
  })

  it('spreads multiple remainder cents across multiple units', () => {
    // 1000 cents / 7 = 142 base, remainder 6 → 1 unit at $1.42, 6 at $1.43.
    expect(splitLotCost(10, 7)).toEqual([
      { quantity: 1, unitCost: 1.42 },
      { quantity: 6, unitCost: 1.43 },
    ])
  })

  it('handles a zero total', () => {
    expect(splitLotCost(0, 3)).toEqual([{ quantity: 3, unitCost: 0 }])
  })

  it('orders the cheaper tier first so FIFO consumes base price first', () => {
    const [first, second] = splitLotCost(10, 3)
    expect(first.unitCost).toBeLessThan(second.unitCost)
  })

  it('rejects a non-positive or non-finite quantity', () => {
    expect(splitLotCost(10, 0)).toEqual([])
    expect(splitLotCost(10, -1)).toEqual([])
    expect(splitLotCost(10, NaN)).toEqual([])
    expect(splitLotCost(NaN, 3)).toEqual([])
  })

  it('always sums back to the requested total, to the cent', () => {
    for (let qty = 1; qty <= 25; qty++) {
      for (const total of [10, 9.99, 0.01, 123.45, 7, 100, 33.33]) {
        expect(tiersTotal(splitLotCost(total, qty))).toBeCloseTo(total, 10)
      }
    }
  })
})

describe('basisFromAdjustments', () => {
  it('leaves the basis untouched when there are no adjustments', () => {
    expect(basisFromAdjustments(10, 1, [])).toEqual({ unitCost: 10, totalBasis: 10 })
    expect(basisFromAdjustments(3.33, 3, [])).toEqual({ unitCost: 3.33, totalBasis: 9.99 })
  })

  // The motivating case: a $10 Zekrom, $20 to grade it, $5 to ship it to PSA.
  it('capitalizes adjustments into a single-unit lot exactly', () => {
    expect(basisFromAdjustments(10, 1, [20, 5])).toEqual({ unitCost: 35, totalBasis: 35 })
  })

  it('spreads an adjustment across a multi-unit lot', () => {
    expect(basisFromAdjustments(10, 4, [20])).toEqual({ unitCost: 15, totalBasis: 60 })
  })

  it('keeps totalBasis exact when the per-unit share does not divide evenly', () => {
    // $10/unit × 3 + $10 = $40 across 3 units. $13.33/unit only accounts for
    // $39.99, so the unit figure rounds but the total must stay honest.
    const { unitCost, totalBasis } = basisFromAdjustments(10, 3, [10])
    expect(totalBasis).toBe(40)
    expect(unitCost).toBe(13.33)
    expect(unitCost * 3).toBeLessThan(totalBasis)
  })

  // The property the invariant exists for: recomputing from scratch means an
  // adjustment can be added and removed forever without the basis drifting.
  it('returns to the original basis when an adjustment is removed', () => {
    const initial = 7.77
    const before = basisFromAdjustments(initial, 3, [])
    const withAdj = basisFromAdjustments(initial, 3, [19.99])
    const after = basisFromAdjustments(initial, 3, [])
    expect(withAdj.totalBasis).toBeCloseTo(before.totalBasis + 19.99, 10)
    expect(after).toEqual(before)
  })

  it('does not drift across many add/remove cycles', () => {
    const amounts: number[] = []
    for (let i = 0; i < 50; i++) amounts.push(0.07)
    const loaded = basisFromAdjustments(3.33, 3, amounts)
    expect(loaded.totalBasis).toBeCloseTo(9.99 + 3.5, 10)
    expect(basisFromAdjustments(3.33, 3, [])).toEqual({ unitCost: 3.33, totalBasis: 9.99 })
  })

  it('guards against a zero or invalid quantity', () => {
    expect(basisFromAdjustments(10, 0, [5])).toEqual({ unitCost: 0, totalBasis: 0 })
    expect(basisFromAdjustments(NaN, 2, [5])).toEqual({ unitCost: 0, totalBasis: 0 })
  })
})
