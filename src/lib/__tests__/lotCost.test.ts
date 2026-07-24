import { describe, it, expect } from 'vitest'
import { splitLotCost, tiersTotal } from '../lotCost'

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
