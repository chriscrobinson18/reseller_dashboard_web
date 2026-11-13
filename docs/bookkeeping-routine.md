# Bookkeeping routine and year-end tie-out

How the books stay accurate with little effort, and what goes to the tax preparer. Process, not code. Public repo: no amounts or merchant names here. Accounting decisions: [books-cleanup-handoff.md](books-cleanup-handoff.md#decision-log); per-platform details: [reconciliation.md](reconciliation.md).

## The model in one paragraph

Income comes from **recorded sales** (the Sales tab). Bank deposits are never income: each is `settlement` (sale proceeds), `transfer` (own money) or `personal`. Settlements are the proof that the sales are complete: the Dashboard's **Year-End Tie-Out** reconciles each channel's recorded sales with the money it paid out. Expenses are categorized bank/card transactions plus a few platform-only costs (the eBay store subscription comes from eBay's report). Inventory uses the traditional method: Part III = beginning + purchases − ending.

## Why not per-deposit settlement linking

The checks a preparer (or an examiner) actually runs work on **annual totals per platform**:

1. **Gross receipts vs. platform reports.** Recorded sales per marketplace agree with that platform's annual report / 1099-K, with differences explained (refunds, buyer-paid shipping, marketplace-collected sales tax).
2. **Every deposit is explained.** No uncategorized credits on business accounts; every deposit is a settlement, transfer, personal item or owner contribution.
3. **Expenses documented and categorized, inventory method consistent.**

The tie-out covers 1 and 2 per year, so per-deposit linking isn't maintained by hand.

## Monthly (≈15 min)

1. Upload the month's eBay **Order Earnings** and **Transaction Report**, the Amazon report, and import TCGplayer orders (re-uploads are safe: only missing rows are added).
2. Record in-person / P2P sales (per sale, or one summary sale per channel per month) **with a payment method**, so the tie-out can match them to the wallet that received the money.
3. Expenses page: categorize anything uncategorized; add a category rule when a merchant repeats with one category.
4. Glance at the Tie-Out card for the current year: new flags or ghost rows mean something is missing.

## Year-end (≈1 hour)

1. Re-import the last months of every platform (December sales pay out in January).
2. Download each platform's annual report / 1099-K and each wallet's year-end statement.
3. **Tie-Out card**, per platform: eBay and Amazon should read "Explained by the report" (or show only explained differences); TCGplayer and others should differ only by timing; wallet deposits without sales are either missing sales or transfers. Resolve every flag and ghost before closing.
4. **Part III card:** save the year-end inventory value (count, estimate, or the lot-based figure it suggests).
5. Export the Dashboard **Schedule C Summary CSV** for the full year ("Last Year" period, so Part III is included).
6. Hand the preparer: the summary CSV, the tie-out results, platform reports / 1099-Ks, and the inventory figures. Open questions for them are in [books-cleanup-handoff.md](books-cleanup-handoff.md#open-questions-for-the-preparer).

## Tooling

- **Year-End Tie-Out** ([features/dashboard.md](features/dashboard.md#year-end-tie-out)): platform table with month drill-down and flags, eBay/Amazon report reconciliation with payout matching and the ghost check, in-person sales matched by payment method, deposits still tagged as income, and the eBay Order Earnings vs Transaction Report check.
- **Part III card** ([features/dashboard.md](features/dashboard.md#part-iii-cost-of-goods-sold--traditional-method-built-2026-11-09)): full-year cost of goods sold with lot-based estimates until values are saved.
