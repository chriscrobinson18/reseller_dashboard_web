import { describe, it, expect } from 'vitest'
import {
  saleNet, computeTieOut, incomeDepositsNeedingSales, compareEbaySources,
  type TieOutSale, type IncomeDepositInput,
} from '../tieOut'

const sale = (o: Partial<TieOutSale>): TieOutSale => ({ platform: 'ebay', sold_at: '2025-03-10T15:00:00Z', sale_price: 100, ...o })

describe('saleNet', () => {
  it('prefers the stored net_payout (platform formulas differ)', () => {
    expect(saleNet(sale({ net_payout: 81.5, fees: 99 }))).toBe(81.5)
  })
  it('accepts a numeric string from PostgREST numeric columns', () => {
    expect(saleNet(sale({ net_payout: '42.10' as unknown as number }))).toBe(42.1)
  })
  it('falls back to price − fees − postage + buyer shipping − refunds', () => {
    expect(saleNet(sale({ fees: 13, shipping_cost: 5, shipping_charged: 4, refunded_amount: 10 }))).toBe(76)
  })
  it('treats a stored net of 0 as real, not missing', () => {
    expect(saleNet(sale({ net_payout: 0, fees: 10 }))).toBe(0)
  })
})

describe('computeTieOut', () => {
  it('sums sales and deposits per platform; difference = deposits − sales net', () => {
    const [p] = computeTieOut(
      [
        sale({ sale_price: 100, fees: 13, shipping_cost: 5, net_payout: 82 }),
        sale({ sale_price: 50, fees: 6.5, shipping_cost: 0, refunded_amount: 0, net_payout: 43.5, sold_at: '2025-04-02' }),
      ],
      [{ date: '2025-03-12', amount: 82, platform: 'eBay' }, { date: '2025-04-05', amount: 40, platform: 'ebay' }],
    )
    expect(p.platform).toBe('ebay')
    expect([p.saleCount, p.gross, p.fees, p.shipping, p.salesNet]).toEqual([2, 150, 19.5, 5, 125.5])
    expect([p.depositCount, p.deposits, p.difference]).toEqual([2, 122, -3.5])
    expect(p.months).toEqual([
      { month: '2025-03', salesNet: 82, deposits: 82, saleCount: 1, depositCount: 1 },
      { month: '2025-04', salesNet: 43.5, deposits: 40, saleCount: 1, depositCount: 1 },
    ])
    expect(p.flags).toEqual([]) // 3.50 is inside the $50 floor
  })

  it('gross includes buyer-paid shipping (Line 1 rule)', () => {
    const [p] = computeTieOut([sale({ platform: 'tcgplayer', sale_price: 20, shipping_charged: 1.99, fees: 2.5, net_payout: 19.49 })], [])
    expect(p.gross).toBe(21.99)
  })

  it('skips the given side of trades (non-cash, never deposited)', () => {
    const out = computeTieOut([sale({ platform: 'trade', trade_id: 't1', net_payout: 500 }), sale({ net_payout: 10 })], [])
    expect(out.map(p => [p.platform, p.saleCount, p.salesNet])).toEqual([['ebay', 1, 10]])
  })

  it('skips soft-deleted sales', () => {
    const [p] = computeTieOut([sale({ net_payout: 10 }), sale({ net_payout: 999, deleted_at: '2025-05-01' })], [])
    expect([p.saleCount, p.salesNet]).toEqual([1, 10])
  })

  it('flags a platform with deposits but no recorded sales', () => {
    const out = computeTieOut([], [{ date: '2025-10-03', amount: 300, platform: 'psa' }])
    expect(out[0].flags).toEqual(['Deposits with no recorded sales'])
  })

  it('groups missing platforms under "unassigned"', () => {
    const out = computeTieOut([sale({ platform: null, net_payout: 5 })], [{ date: '2025-01-01', amount: 5 }])
    expect(out.map(p => p.platform)).toEqual(['unassigned'])
    expect(out[0].difference).toBe(0)
  })

  it('flags months with deposits but no sales (unimported months)', () => {
    const [p] = computeTieOut(
      [sale({ net_payout: 100, sold_at: '2026-09-15' })],
      [{ date: '2026-09-17', amount: 100, platform: 'ebay' }, { date: '2026-10-04', amount: 80, platform: 'ebay' }, { date: '2026-11-02', amount: 70, platform: 'ebay' }],
    )
    expect(p.flags).toContain('Deposits but no sales in 2026-10, 2026-11')
    expect(p.flags).toContain('Deposits exceed recorded sales: sales may be missing')
  })

  it('tolerance is max($50, 5% of sales net), strictly greater than', () => {
    const run = (dep: number) => computeTieOut([sale({ net_payout: 2000 })], [{ date: '2025-03-11', amount: dep, platform: 'ebay' }])[0].flags
    expect(run(2100)).toEqual([])                     // exactly 5% → not flagged
    expect(run(2100.01)).toEqual(['Deposits exceed recorded sales: sales may be missing'])
    expect(run(1899.99)).toEqual(['Recorded sales exceed deposits: payouts may be missing or still pending'])
    const small = (dep: number) => computeTieOut([sale({ net_payout: 100 })], [{ date: '2025-03-11', amount: dep, platform: 'ebay' }])[0].flags
    expect(small(150)).toEqual([])                    // $50 floor beats 5% of 100
    expect(small(150.01)).toHaveLength(1)
  })

  it('does not apply the difference flag when one side is empty', () => {
    const [p] = computeTieOut([sale({ net_payout: 5000 })], [])
    expect(p.flags).toEqual([])
  })

  it('rounds to cents (no float drift)', () => {
    const [p] = computeTieOut(Array.from({ length: 10 }, () => sale({ net_payout: 0.1 })), [{ date: '2025-03-01', amount: 1, platform: 'ebay' }])
    expect(p.salesNet).toBe(1)
    expect(p.difference).toBe(0)
  })

  it('sorts platforms by activity, largest first', () => {
    const out = computeTieOut(
      [sale({ platform: 'tcgplayer', net_payout: 10 }), sale({ platform: 'ebay', net_payout: 500 })],
      [{ date: '2025-01-01', amount: 40, platform: 'amazon' }],
    )
    expect(out.map(p => p.platform)).toEqual(['ebay', 'amazon', 'tcgplayer'])
  })

  it('buckets a UTC timestamp by its calendar date, not local time', () => {
    const [p] = computeTieOut([sale({ net_payout: 1, sold_at: '2025-12-31T23:30:00+00:00' })], [])
    expect(p.months[0].month).toBe('2025-12')
  })
})

describe('incomeDepositsNeedingSales', () => {
  const dep = (o: Partial<IncomeDepositInput>): IncomeDepositInput => ({ id: 'x', date: '2025-05-01', amount: 100, schedule_c_category: 'payout', source: 'plaid', ...o })
  it('keeps unlinked positive payout deposits, largest first', () => {
    const out = incomeDepositsNeedingSales([dep({ id: 'a', amount: 50 }), dep({ id: 'b', amount: 200 })])
    expect(out.map(t => t.id)).toEqual(['b', 'a'])
  })
  it('drops settlements, debits, CSV rows and anything linked to a sale, bundle, trade or net-zero pair', () => {
    const out = incomeDepositsNeedingSales([
      dep({ id: 'keep' }),
      dep({ id: 'cat', schedule_c_category: 'settlement' }),
      dep({ id: 'rt', record_type: 'settlement' }),
      dep({ id: 'neg', amount: -20 }),
      dep({ id: 'zero', amount: 0 }),
      dep({ id: 'csv', source: 'csv_import' }),
      dep({ id: 'sale', related_sale_id: 's1' }),
      dep({ id: 'bundle', related_bundle_id: 'b1' }),
      dep({ id: 'trade', trade_id: 't1' }),
      dep({ id: 'nz', net_zero_pair_id: 'n1' }),
      dep({ id: 'other', schedule_c_category: 'cost_of_goods' }),
    ])
    expect(out.map(t => t.id)).toEqual(['keep'])
  })
})

describe('compareEbaySources', () => {
  const es = (order: string, o: Record<string, unknown> = {}) => ({ external_order_id: order, sold_at: '2025-06-01T10:00:00Z', sale_price: 100, fees: 15, shipping_cost: 5, refunded_amount: 0, ...o })
  const row = (order: string, cat: string, amount: number) => ({ notes: order, date: '2025-06-01', amount, schedule_c_category: cat })

  it('matches an order whose fields agree (advertising counts as a fee)', () => {
    const r = compareEbaySources([es('1-1')], [
      row('1-1', 'payout', 100), row('1-1', 'commissions_fees', -12), row('1-1', 'advertising', -3), row('1-1', 'shipping_postage', -5),
    ])
    expect(r).toEqual({ ordersCompared: 1, matching: 1, mismatched: [], onlyInEarnings: [], onlyInReport: [] })
  })

  it('reports each differing field, and orders present on only one side', () => {
    const r = compareEbaySources(
      [es('A', { sold_at: '2025-07-01' }), es('B', { refunded_amount: 40 }), es('C'), es('gone', { deleted_at: 'x' })],
      [
        row('A', 'payout', 100), row('A', 'commissions_fees', -15), row('A', 'shipping_postage', -3.2),   // labels under-reported
        row('B', 'payout', 100), row('B', 'commissions_fees', -15), row('B', 'shipping_postage', -5), row('B', 'payout', -25), row('B', 'returns_allowances', -15),
        row('D', 'payout', 9),
        row('', 'payout', 1),          // no order number → ignored
        row('A', 'cost_of_goods', -1), // unrelated category → ignored
      ],
    )
    expect(r.ordersCompared).toBe(2)
    expect(r.matching).toBe(1) // B: refunds 25 + 15 = 40
    expect(r.mismatched).toEqual([{ order: 'A', date: '2025-07-01', fields: [{ field: 'shipping', earnings: 5, report: 3.2 }] }])
    expect(r.onlyInEarnings).toEqual(['C'])
    expect(r.onlyInReport).toEqual(['D'])
  })

  it('ignores sub-cent float noise', () => {
    const r = compareEbaySources([es('Z', { fees: 0.3, shipping_cost: 0 })], [row('Z', 'payout', 100), row('Z', 'commissions_fees', -0.1), row('Z', 'commissions_fees', -0.2)])
    expect(r.matching).toBe(1)
  })

  it('with a year, keeps only orders attributed to that year (window noise dropped)', () => {
    const r = compareEbaySources(
      [es('in', { sold_at: '2026-01-05' }), es('prev', { sold_at: '2025-12-20' })],
      [
        row('in', 'payout', 100), row('in', 'commissions_fees', -15), row('in', 'shipping_postage', -5),
        row('prev', 'payout', 100),
        { ...row('rep-prev', 'payout', 9), date: '2025-12-30' },
        { ...row('rep-in', 'payout', 9), date: '2025-12-31' }, { ...row('rep-in', 'payout', 1), date: '2025-11-02' }, // first row decides
        { ...row('rep-new', 'payout', 9), date: '2026-02-01' },
      ],
      2026,
    )
    expect([r.ordersCompared, r.matching, r.mismatched.length]).toEqual([1, 1, 0])
    expect(r.onlyInReport).toEqual(['rep-new'])
    expect(r.onlyInEarnings).toEqual([])
  })

  it('sums an order stored as several sale lines', () => {
    const r = compareEbaySources(
      [es('M', { sale_price: 60, fees: 9, shipping_cost: 3 }), es('M', { sale_price: 40, fees: 6, shipping_cost: 2, sold_at: '2025-05-31' })],
      [row('M', 'payout', 100), row('M', 'commissions_fees', -15), row('M', 'shipping_postage', -5)],
    )
    expect([r.ordersCompared, r.matching]).toEqual([1, 1])
  })
})
