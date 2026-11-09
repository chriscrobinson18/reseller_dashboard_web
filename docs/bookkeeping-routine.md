# Bookkeeping routine and year-end tie-out

How the books are kept accurate with minimal effort, and what gets handed to the tax preparer. Decided 2026-11-09 during the books cleanup (see [`TASKS.md`](../TASKS.md) "Books Cleanup"). This file is process, not code: no amounts or merchant names belong here (public repo).

## Why not per-deposit settlement linking

Linking every bank deposit to the exact sales it pays out is the most expensive control and not one a preparer requires for a Schedule C reseller. The checks a CPA (or an IRS examiner) actually runs work on **annual totals per platform**:

1. **Gross receipts vs. platform reports.** Sales reported for each marketplace must agree with that platform's annual report / Form 1099-K, with differences explained (refunds, buyer-paid shipping, marketplace-collected sales tax).
2. **Every deposit is explained.** Total deposits minus non-income sources (transfers, loans, owner contributions) must not exceed reported income (the "bank deposits" method). In the app: no uncategorized credits on business accounts, and each one labeled `settlement` / `transfer` / `payout` / owner contribution (Phase 2).
3. **Expenses documented and categorized, inventory method consistent** (Phase 1; inventory method in TASKS P2).

Per-deposit linking that already exists (eBay / Amazon CSV auto-match in Settings → Settlement Status) stays as a convenience; it isn't maintained by hand.

**One hard rule remains:** a marketplace deposit is only re-tagged from income (`payout`) to `settlement` once its sales are known to be recorded (a linked CSV payout group, or the platform's month is fully imported). Otherwise the income disappears from the books.

## Monthly (≈15 min)

1. Upload the month's eBay and Amazon CSVs; import TCGplayer orders.
2. Record P2P / cash sales: per sale, or one summary sale per channel per month.
3. Expenses page: categorize anything uncategorized. Create a category rule when a merchant repeats and is always the same category.

## Year-end (≈1 hour)

1. Download each platform's annual report / 1099-K and each wallet's (PayPal, Cash App) year-end statement.
2. Fill the **tie-out** per platform per year:

   | Column | Source |
   |---|---|
   | Sales gross, fees, shipping, refunds, net | App (`sales`) |
   | Gross per platform report / 1099-K | Platform |
   | Deposits received | App (`settlement` deposits for that platform) |
   | Difference + explanation | Timing (Dec sales paid in Jan), wallet balance change, wallet-funded purchases, missing imports |

   A small timing difference is normal. A difference that matches a gap in imported months means sales are missing.
3. Export the Dashboard **Schedule C Summary CSV** for the year.
4. Hand the preparer: summary CSV + tie-out + platform reports + inventory figures (if required by the chosen method).

## Open questions for the preparer

- Inventory method: NIMS (§471(c)) or traditional (§471)? Decides whether year-end inventory values are needed (Phase 5).
- Is a few-percent annual timing difference between payouts and recorded sales acceptable with a written explanation?
- Credit card rewards: reduce expenses (current setup: "Credit Card Rewards", Line 27a) or exclude?
- After closing 2025: amend (1040-X) or not?

## Planned tooling

A read-only **Year-End Tie-Out** table on the Dashboard (platform × year: sales gross, fees, refunds, net, deposits, difference), built before Phase 2. Tracked in TASKS.md.
