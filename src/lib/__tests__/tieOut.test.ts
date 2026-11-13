import { describe, it, expect } from 'vitest'

const r2 = (n: number) => Math.round(n * 100) / 100
import {
  saleNet, computeTieOut, tieOutTargets, incomeDepositsNeedingSales, compareEbaySources,
  computePlatformLedger, applyLedgers,
  type TieOutSale, type IncomeDepositInput, type LedgerRow, type LedgerSale,
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
      [sale({ platform: 'goldin', net_payout: 100, sold_at: '2026-09-15' })],
      [{ date: '2026-09-17', amount: 100, platform: 'goldin' }, { date: '2026-10-04', amount: 80, platform: 'goldin' }, { date: '2026-11-02', amount: 70, platform: 'goldin' }],
    )
    expect(p.flags).toContain('Deposits but no sales in 2026-10, 2026-11')
    expect(p.flags).toContain('Deposits exceed recorded sales: sales may be missing')
  })

  it('tolerance is max($50, 5% of sales net), strictly greater than', () => {
    const run = (dep: number) => computeTieOut([sale({ platform: 'goldin', net_payout: 2000 })], [{ date: '2025-03-11', amount: dep, platform: 'goldin' }])[0].flags
    expect(run(2100)).toEqual([])                     // exactly 5% → not flagged
    expect(run(2100.01)).toEqual(['Deposits exceed recorded sales: sales may be missing'])
    expect(run(1899.99)).toEqual(['Recorded sales exceed deposits: payouts may be missing or still pending'])
    const small = (dep: number) => computeTieOut([sale({ platform: 'goldin', net_payout: 100 })], [{ date: '2025-03-11', amount: dep, platform: 'goldin' }])[0].flags
    expect(small(150)).toEqual([])                    // $50 floor beats 5% of 100
    expect(small(150.01)).toHaveLength(1)
  })

  it('does not apply the difference flag when one side is empty (only the no-deposits flag)', () => {
    const [p] = computeTieOut([sale({ net_payout: 5000 })], [])
    expect(p.flags).toHaveLength(1)
    expect(p.flags[0]).toMatch(/no deposits/)
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

describe('in-person sales route to their payment rail', () => {
  const base = { sold_at: '2026-05-02T12:00:00Z', sale_price: 100, fees: 0 }
  it('marketplaces stay under their own platform even with a payment method', () => {
    expect(tieOutTargets({ ...base, platform: 'ebay', payment_method: 'paypal' })).toEqual([{ key: 'ebay', share: 1 }])
  })
  it('manual + venmo files under venmo; no method stays manual', () => {
    expect(tieOutTargets({ ...base, platform: 'manual', payment_method: 'venmo' })).toEqual([{ key: 'venmo', share: 1 }])
    expect(tieOutTargets({ ...base, platform: 'manual', payment_method: 'card' })).toEqual([{ key: 'manual', share: 1 }])
  })
  it('split payments divide the sale across rails by amount', () => {
    expect(tieOutTargets({ ...base, platform: 'manual', payment_method: 'split', payments: [{ method: 'cash', amount: 60 }, { method: 'venmo', amount: 40 }] }))
      .toEqual([{ key: 'cash', share: 0.6 }, { key: 'venmo', share: 0.4 }])
  })
  it('ties a manual PayPal sale to PayPal deposits; cash needs no deposit; unrouted sales are flagged', () => {
    const out = computeTieOut(
      [
        { ...base, platform: 'manual', payment_method: 'paypal', net_payout: 100 },
        { ...base, platform: 'manual', payment_method: 'cash', net_payout: 50 },
        { ...base, platform: 'manual', net_payout: 20 },
      ],
      [{ date: '2026-05-03', amount: 100, platform: 'paypal' }],
    )
    const by = Object.fromEntries(out.map(p => [p.platform, p]))
    expect([by.paypal.saleCount, by.paypal.difference, by.paypal.flags]).toEqual([1, 0, []])
    expect(by.cash.flags).toEqual([])
    expect(by.manual.flags[0]).toMatch(/payment method/)
  })
  it('flags a marketplace with sales but no deposits', () => {
    const [p] = computeTieOut([{ ...base, platform: 'tcgplayer', net_payout: 10 }], [])
    expect(p.flags[0]).toMatch(/no deposits/)
  })
})

describe('held-balance / payout-lag platforms (eBay, Amazon, TCGplayer)', () => {
  const dep = (amount: number, date = '2026-05-03', platform = 'ebay') => ({ date, amount, platform })

  it('no monthly flags: a payout in a later month is normal', () => {
    const [p] = computeTieOut(
      [sale({ platform: 'tcgplayer', net_payout: 100, sold_at: '2026-01-28' })],
      [dep(100, '2026-02-04', 'tcgplayer')],
    )
    expect([p.flags, p.notes]).toEqual([[], []])
  })

  it('sales above deposits is a note (held / not yet paid out), never a flag', () => {
    const [p] = computeTieOut([sale({ net_payout: 2000, sold_at: '2026-05-01' })], [dep(1000)])
    expect(p.flags).toEqual([])
    expect(p.notes[0]).toMatch(/1,000\.00 not yet paid out/)
  })

  it('deposits above sales: covered by last year\'s held balance → note; beyond it → flag', () => {
    const prior = { sales: [sale({ net_payout: 900, sold_at: '2025-12-20' })], deposits: [dep(400, '2025-12-22')] } // 500 held at year end
    const run = (d: number) => computeTieOut([sale({ net_payout: 1000, sold_at: '2026-03-01' })], [dep(d)], prior)[0]
    const covered = run(1500) // excess 500 = carry 500
    expect(covered.flags).toEqual([])
    expect(covered.notes[0]).toMatch(/covered by \$500\.00 held/)
    const over = run(1600) // excess 600 > carry 500 + $50 tolerance
    expect(over.flags[0]).toMatch(/last year's held balance \(\$500\.00\) by \$100\.00/)
  })

  it('first tracked year (no prior sales): deposits above sales is a note, not a flag', () => {
    const [p] = computeTieOut([sale({ platform: 'amazon', net_payout: 100 })], [dep(800, '2025-01-05', 'amazon')], { sales: [], deposits: [] })
    expect(p.flags).toEqual([])
    expect(p.notes[0]).toMatch(/carried in from last year \(no sales recorded then/)
  })

  it('sales with no deposits at all are still flagged', () => {
    const [p] = computeTieOut([sale({ platform: 'tcgplayer', net_payout: 50 })], [])
    expect(p.flags[0]).toMatch(/no deposits/)
  })
})

describe('computePlatformLedger (eBay/Amazon report reconciliation)', () => {
  const row = (o: Partial<LedgerRow>): LedgerRow => ({ date: '2026-03-01', amount: 0, schedule_c_category: 'payout', notes: null, platform: 'ebay', ...o })
  const sales = [
    sale({ platform: 'ebay', sold_at: '2026-03-01T12:00:00Z', net_payout: 85, external_order_id: 'O1' } as Partial<TieOutSale>),
    sale({ platform: 'ebay', sold_at: '2026-03-05T12:00:00Z', net_payout: 50, external_order_id: 'O2' } as Partial<TieOutSale>),
  ]
  const rows = [
    row({ amount: 100, notes: 'O1' }), row({ amount: -10, schedule_c_category: 'commissions_fees', notes: 'O1' }),
    row({ amount: -5, schedule_c_category: 'shipping_postage', notes: null }),       // label bought separately
    row({ date: '2026-03-05', amount: 60, notes: 'O2' }),                              // Sales tab says 50
    row({ date: '2026-03-06', amount: -3, schedule_c_category: 'advertising', notes: 'O2' }),
    row({ date: '2026-03-10', amount: -100, schedule_c_category: 'transfer' }),
    row({ date: '2026-03-20', amount: -40, schedule_c_category: 'transfer' }),
  ]

  it('bridges recorded sales to report payouts exactly', () => {
    const l = computePlatformLedger('ebay', 2026, sales, rows, [])
    // O2's −3 promoted-listing fee carries its order number, so it counts in the order (as Order Earnings does).
    expect([l.recordedNet, l.reportOrderNet, l.orderDifference]).toEqual([135, 147, 12])
    expect(l.notOnOrdersTotal).toBe(-5)       // only the label bought without an order number
    expect(l.balanceChange).toBe(2)           // 147 − 5 − 140 paid out
    expect(l.reportPayouts).toBe(140)
    expect(r2(l.recordedNet + l.orderDifference + l.notOnOrdersTotal - l.balanceChange)).toBe(l.reportPayouts)
    expect(l.orderDiffs).toEqual([{ orderId: 'O2', date: '2026-03-05', recorded: 50, report: 57, difference: 7 }, { orderId: 'O1', date: '2026-03-01', recorded: 85, report: 90, difference: 5 }])
  })

  it('matches payouts exactly, then net of a small transfer fee; leftovers are unexplained', () => {
    const l = computePlatformLedger('ebay', 2026, sales, rows, [
      { date: '2026-03-12', amount: 100, platform: 'ebay' },  // exact
      { date: '2026-03-20', amount: 38, platform: 'ebay' },   // 40 − $2 instant-transfer fee
      { date: '2026-06-01', amount: 9.99, platform: 'ebay' }, // not in the report
    ])
    expect(l.feeMatched).toEqual([{ date: '2026-03-20', amount: 40, bankDate: '2026-03-20', bankAmount: 38, fee: 2 }])
    expect(l.unmatchedReportPayouts).toEqual([])
    expect(l.unmatchedBankDeposits).toEqual([{ date: '2026-06-01', amount: 9.99 }])
    expect(l.unexplained).toBe(9.99)
    expect(l.flags[0]).toMatch(/1 bank deposit not in the report/)
  })

  it('a report payout with no deposit is flagged; a deposit in the report\'s first week is pre-report', () => {
    const l = computePlatformLedger('ebay', 2026, sales, rows, [{ date: '2026-03-03', amount: 15, platform: 'ebay' }])
    expect(l.unmatchedReportPayouts.map(p => p.amount)).toEqual([100, 40])
    expect(l.beforeReport).toEqual([{ date: '2026-03-03', amount: 15 }])
    expect(l.unexplained).toBe(-140)
  })

  it('applyLedgers swaps timing notes for ledger flags only where a report exists', () => {
    const base = computeTieOut(sales, [{ date: '2026-03-12', amount: 100, platform: 'ebay' }])
    const withReport = applyLedgers(base, [computePlatformLedger('ebay', 2026, sales, rows, [])])
    expect(withReport[0].ledger?.platform).toBe('ebay')
    expect(withReport[0].notes).toEqual([])
    const noReport = applyLedgers(base, [computePlatformLedger('ebay', 2026, sales, [], [])])
    expect(noReport[0].ledger).toBeUndefined()
  })
})

describe('computePlatformLedger: labels bought separately, purchases, card charges', () => {
  const row = (o: Partial<LedgerRow>): LedgerRow => ({ date: '2026-03-01', amount: 0, schedule_c_category: 'payout', notes: null, platform: 'ebay', ...o })
  const sales = [sale({ platform: 'ebay', sold_at: '2026-03-01T12:00:00Z', net_payout: 90, external_order_id: 'S1' } as Partial<TieOutSale>)]
  it('a label billed without an order number offsets the order difference; no flag when nothing else remains', () => {
    const l = computePlatformLedger('ebay', 2026, sales, [
      row({ amount: 100, notes: 'S1' }),                                    // Sales tab net 90 already deducts the $10 label
      row({ amount: -10, schedule_c_category: 'shipping_postage' }),        // report bills the label separately
      row({ amount: -100, schedule_c_category: 'cost_of_goods', notes: 'BOUGHT-1' }), // eBay funds purchase
      row({ amount: 100, schedule_c_category: 'other_expense', merchant: 'Charge for refund cost from Visa ending in 0000' }),
    ], [], [
      // both are in the books, so neither is a ghost
      { date: '2026-03-02', amount: -100, schedule_c_category: 'settlement', record_type: 'settlement', platform: 'ebay', merchant: 'eBay' },
      { date: '2026-03-01', amount: -100, schedule_c_category: 'cost_of_goods', record_type: 'transaction', platform: null, merchant: 'eBay' },
    ])
    expect([l.orderDifference, l.separateLabels, l.orderDifferenceAfterLabels]).toEqual([10, -10, 0])
    expect(l.orderDiffs.map(d => d.orderId)).toEqual(['S1'])               // the purchase is not one of your orders
    expect(l.notOnOrders.map(n => n.label)).toEqual([
      'eBay funds purchases (inventory bought with your balance)', 'Shipping labels not on an order', 'Paid in from your card/bank (eBay charges)',
    ])
    expect(l.flags).toEqual([])
  })
})

describe('computePlatformLedger ghost check (report rows that reach the books by no path)', () => {
  const row = (o: Partial<LedgerRow>): LedgerRow => ({ date: '2026-03-01', amount: 0, schedule_c_category: 'payout', notes: null, platform: 'ebay', ...o })
  const noSales: LedgerSale[] = []
  const rows = [
    row({ amount: -30, schedule_c_category: 'commissions_fees', merchant: 'Store (Basic): Subscription Fee Feb 28-Mar 30' }), // on Schedule C
    row({ amount: -12.5, schedule_c_category: 'shipping_postage', merchant: 'eBay Shipping Label' }),                          // Sales tab covers it
    row({ amount: -400, schedule_c_category: 'balance_adjustment', merchant: 'Hold placed' }),                                 // balance mechanics
    row({ amount: 0, schedule_c_category: 'commissions_fees', merchant: 'Insertion Fee' }),                                    // $0
    row({ amount: 20, schedule_c_category: 'other_expense', merchant: 'Charge for accrued selling costs from Chase Bank ending in 1111' }),
    row({ amount: 50, schedule_c_category: 'other_expense', merchant: 'Charge for refund cost from Visa ending in 2222' }),
    row({ amount: -100, schedule_c_category: 'cost_of_goods', notes: 'BOUGHT', merchant: 'eBay funds purchase: ETB' }),
    row({ amount: -3, schedule_c_category: 'advertising', merchant: 'Promoted Listings Advanced' }),
  ]
  const books = [
    { date: '2026-03-02', amount: -20, schedule_c_category: 'settlement', record_type: 'settlement', platform: 'ebay', merchant: 'eBay' },
    { date: '2026-03-02', amount: -100, schedule_c_category: 'cost_of_goods', record_type: 'transaction', platform: null, merchant: 'eBay' },
  ]
  it('lists only rows with no path: an unsynced card charge and an ad without an order', () => {
    const l = computePlatformLedger('ebay', 2026, noSales, rows, [], books)
    expect(l.ghosts.map(g => [g.amount, g.description])).toEqual([
      [50, 'Charge for refund cost from Visa ending in 2222'],
      [-3, 'Promoted Listings Advanced'],
    ])
    expect(l.flags.some(f => /2 report rows not accounted for anywhere/.test(f))).toBe(true)
  })
  it('a fee and its later reversal cancel out instead of showing as two ghosts', () => {
    const l = computePlatformLedger('ebay', 2026, noSales, [
      row({ date: '2026-06-30', amount: -0.25, schedule_c_category: 'commissions_fees', merchant: 'Insertion Fee' }),
      row({ date: '2026-07-07', amount: 0.25, schedule_c_category: 'commissions_fees', merchant: 'Insertion Fee' }),
    ], [])
    expect(l.ghosts).toEqual([])
  })
  it('a charge or purchase with no matching book row is a ghost', () => {
    const l = computePlatformLedger('ebay', 2026, noSales, rows.slice(4, 7), [])
    expect(l.ghosts.map(g => g.amount)).toEqual([20, 50, -100])
  })
})
