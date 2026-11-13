# Platform reconciliation

How each sales channel's money moves, what reaches Schedule C, and how the Year-End Tie-Out proves nothing is missing. This is reference knowledge gathered during the 2025–26 books cleanup; the card itself is documented in [features/dashboard.md](features/dashboard.md#year-end-tie-out), the accounting decisions in [books-cleanup-handoff.md](books-cleanup-handoff.md#decision-log). Public repo: no amounts, account numbers, order numbers or personal names here.

## Principles

1. **Income comes from recorded sales**, never from deposits ([categories.md](categories.md#sales-based-income-2026-11-09)). A deposit is `settlement` (sale proceeds arriving), `transfer` (own money) or `personal`.
2. **Every dollar the platform moved must be accounted for.** For platforms with a complete ledger export (eBay, Amazon), the tie-out bridges recorded sales to payouts line by line and matches each payout to a bank deposit; anything left over is "unexplained" and should be $0.
3. **A report row with no order number must reach the books by some path** (Sales tab, Schedule C, a matching bank/card row) or the tie-out lists it as a **ghost**. This is how a cost that exists only on the platform (it was the eBay store fee) gets noticed.
4. **A refund is deducted in the year it is paid**, even when the sale was in an earlier year (as long as that sale was reported as income). Prior-year sales aren't in the Sales tab, so their refunds are entered as manual rows (see Amazon below).
5. **Sources rank:** the platform's per-order earnings report (what the Sales tab imports) is authoritative for income, fees and labels; the platform's transaction/ledger report is the cross-check.

## eBay

Two exports, both imported in Settings:

| Export | Lands in | Role |
|---|---|---|
| **Order Earnings** | `sales` (one row per order) | **Authoritative.** Gross, every fee column (final value fixed/variable, below-standard performance, international, regulatory, promoted listing standard…), shipping labels, refunds. Verified 2026-11-13: the Sales tab matches Order Earnings exactly for every 2025 and 2026 order. |
| **Transaction Report** | `transactions`, `source = 'csv_import'` | Complete ledger of the seller balance: order credits, fees, labels, ads, store subscription, holds, refunds, charges to your card/bank, **every payout**. Audit detail, except the store subscription (below). Parser: [`_shared/ebayTransactionReport.ts`](../supabase/functions/_shared/ebayTransactionReport.ts). |

How eBay items reach Schedule C:

| Item | Path |
|---|---|
| Sale, fees (incl. promoted listing), labels, refunds | The `sales` row (Order Earnings) |
| **Store subscription** | The Transaction Report row itself (`isEbayStoreSubscriptionRow`, Line 10): eBay takes it from the balance before paying out, so it is in neither Order Earnings nor the bank. The only report row that counts. |
| Labels the report bills **without an order number** | Already in the Sales tab: Order Earnings charges each label to its order. The tie-out shows them offsetting the order difference (`separateLabels`). |
| **"Charge for … from Visa/Chase …"** (eBay pulls money from your card/bank when the balance goes negative) | **Not an expense.** The card/bank row is tagged `settlement` / platform `ebay`: the reverse of a payout. The refund, label or fee it funded is already deducted via the Sales tab; tagging the charge as an expense double-counts it. |
| **eBay funds purchase** (you bought something on eBay with your seller balance) | A normal `cost_of_goods` purchase (with its inventory lot). The report row carries the order number of what you *bought*, so the tie-out keeps it out of your sales. |
| Holds placed / released | Balance mechanics, net to zero. |
| Payouts | `settlement` deposits, matched one-to-one by the tie-out (exact amount, or the bank amount up to $5 lower for eBay's instant-transfer fee). |
| Cancelled orders | Report: sale credit, fee, then a refund net of the fee reversal; Sales tab: full return. Both net to the same, so they don't show as differences. |

Import pitfalls fixed 2026-11-13 (see the parser header): rows with Transaction ID `0` collapsing into one key, unbooked fee columns, a label and its later "Underpaid" postage adjustment colliding on one tracking-number key, same-day charges colliding, skipped Purchase rows. Each report file now books exactly eBay's Net amount; re-imports add only missing rows.

**Remaining expected difference:** labels billed in January for orders sold in December of the prior year (the order is in the prior year's Order Earnings, the label in this year's report).

## Amazon

- **Report:** the Amazon Date Range Transaction Report (`amz_dr_*` rows) is also a complete ledger with every transfer, so Amazon gets the same bridge and payout matching as eBay.
- **Sales:** built from the report by `sync_csv_orders_to_sales` ([settings.md](features/settings.md)). Known gap: Amazon refunds are netted into `sale_price` instead of going to `refunded_amount` (Line 2). Open in TASKS.md.
- **Refunds of prior-year sales:** an order sold in December and refunded in January has no sale in the new year. Its refund, the fee credit and the return label are copied from the report as manual rows (Line 2 / Line 10 / Line 27a) in the year they happened; notes cite the report row. The tie-out still lists those orders as differences (the Sales tab has no prior-year orders): that is expected.
- A one-cent payout is Amazon's bank-verification test deposit; it can land weeks after the report entry (matching allows 30 days for an exact amount).
- "Debt carry" rows are balance mechanics.

## TCGplayer

- **No ledger export** is imported, so TCGplayer uses the payout-timing rule in the tie-out ([features/dashboard.md](features/dashboard.md#year-end-tie-out)), not the bridge.
- **Payout history** (seller portal → Payments) is the reconciliation source: one row per payout batch with orders, sales, fees, refunded orders, refunded fees, adjustments and payment. For each row, payment = sales − fees − refunds + refunded fees + adjustments, **plus any negative balance carried from the previous row**: a negative payment never touches the bank; it is netted out of the next one.
- **Order export** (Tampermonkey userscript, `import_tcgplayer_orders`) is the per-order check: order status, net, refunds. The import ignores `refunds[]` (open in TASKS.md), so compare refunded orders against the Sales tab and fix them (refund on the sale, fee reduced by the fee TCGplayer refunded, so gross − refund − fees = cash paid). A canceled order that was imported as a sale becomes a full return.
- An **adjustment** that offsets a refund means TCGplayer funded the refund; the seller keeps the original net.
- Small deposits labelled "ACCTVERIFY" when a payout account is added are bank-verification deposits, not sale proceeds.
- Payout dates: the history's "Estimated Transfer Arrival" can be days after TCGplayer's "completed" email; date deposits by when they actually arrived (this decides the tax year near New Year).
- Expected year-end difference: December orders paid out in January.

## In-person sales and wallets

- In-person venues (`manual`, Facebook Marketplace / Groups, Discord) have no settlement of their own. The tie-out files each sale under the rail it was paid through via `sales.payment_method` (`tieOutTargets`): PayPal / Venmo / Cash App / Zelle deposits; **cash** expects no deposit; split payments divide by amount ([data-flows.md](data-flows.md#split-payments-payments-jsonb)).
- Set a payment method on every in-person sale, or it can't be matched (the tie-out flags them).
- Wallet deposits with no recorded sales are the Phase 2/3 backlog: each is either an unrecorded sale (missing income) or a transfer/personal item.

## Other channels

- **Auction house / grading company** payouts (e.g. `goldin`, `psa` in `SALE_PLATFORMS`): record the sale with that platform so it matches its deposit.

## Manual entries for money outside the bank feed

Some money lands in accounts the app doesn't sync (a closed account, an account that was never linked, a card whose sync is off). Conventions:

- Add the deposit (or eBay charge) by hand as a `settlement` row with the correct `platform`, `account_display` naming the account (suffix "(not in bank feed)" when it has no feed), `review_status = 'ai_reviewed'` if an assistant added it, and a note citing the evidence (platform payout history, receipt email). Date it by when the money actually arrived.
- **If that account is ever synced or its statements imported, delete the manual rows first**, or the money appears twice. Find them by `source = 'manual'` and the note.
- Use statements of such accounts to look for **business expenses** that never reached the books.
