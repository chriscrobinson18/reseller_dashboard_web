# Books cleanup — start here

Last updated 2026-11-13. Scope: Schedule C accuracy for tax years **2025 (amended return)** and **2026 (filing)**; 2024 is out of scope except where a 2024 sale or purchase affects 2025. Per-item sale ↔ inventory linking is not required for past years.

Read this, then the open items in [`TASKS.md`](../TASKS.md) "Books cleanup", then [reconciliation.md](reconciliation.md) (how each platform reconciles) and [operations.md](operations.md) (how to work against production). This repo is **public**: never put amounts, merchant names, account numbers, order numbers or personal names in commits, docs or code comments. Running totals belong in chat only.

## Working rules (owner's standing instructions)

- **Branch:** work on the session's feature branch; release by fast-forwarding `main` (Vercel deploys `main`) when the owner approves. No PR unless asked.
- **Approval first** for any production data write, migration or edge-function deploy, proposed in batches with a reason per item. Procedure: [operations.md](operations.md#data-writes-production).
- **Validate every number twice:** recompute totals a second way before reporting.
- **AI-made data writes** set `review_status = 'ai_reviewed'`; rows the owner marked `owner_reviewed` are locked (the database refuses changes; list them for the owner instead).
- Rows sharing date + amount + merchant are genuine repeat charges: categorize, never delete.

## Decision log

| Date | Topic | Decision |
|---|---|---|
| 2026-11-09 | Income | **From the Sales tab only** (`sales` rows): gross on Line 1, refunds on Line 2, fees on Line 10, platform-deducted labels on Line 27a. Implementation: [categories.md](categories.md#sales-based-income-2026-11-09). |
| 2026-11-09 | Settlements | **Insurance only:** the year-end tie-out proves every sale is recorded. Per-deposit linking dropped (preparers don't require it). |
| 2026-11-09 | Inventory method | **Traditional (§471):** Part III = beginning + purchases − ending with stored year-end values ([features/dashboard.md](features/dashboard.md#part-iii-cost-of-goods-sold--traditional-method-built-2026-11-09)). |
| 2026-11-09 | Marketplace deposits | eBay, Amazon, TCGplayer deposits are always `settlement`. Income for a month whose sales aren't imported is missing until the import happens. |
| 2026-11-10 | Every other deposit | **No bank deposit is income.** Each is `settlement` (with a `platform` label so the tie-out shows it), `transfer` (own money) or `personal`, even before its sales are recorded; the tie-out is the worklist and income is understated until Phase 3 records the sales. Replaces the earlier "record the sales first, then re-tag" rule. Rare non-sale business income (platform bonuses) may still be tagged `payout` deliberately. |
| 2026-11-09 | Owner's money (going forward) | Deposit all business money first, then pay yourself from the bank. Venmo is personal-only. Bank accounts in the app are business-only. Personal spending of business money before it's deposited is an owner's draw: not deductible, and it doesn't reduce income. |
| 2026-11-09 | Card refunds | Re-tag to the original purchase's category (usually cost of goods) so they net. |
| 2026-11-09 | Card cash-back | Custom category "Credit Card Rewards" (Line 27a), a reduction of expenses (the purchases that earned it were deducted). |
| 2026-11-09 | Custom categories | "Memberships" (Line 27a; refunds use the same category; merchants selling both goods and memberships get no auto-rule), "Tech & Dev Tools" (Line 27a; deliberately not "R&D", which is a separate §174 regime), "Software & Subscriptions" (Line 27a). See [categories.md](categories.md#custom-categories-in-use). |
| 2026-11-09 | Card payments, wallet cash-outs | Credit-card payments → `transfer` (sync rule). PayPal / Cash App cash-outs → `settlement` (sync rule). |
| 2026-11-09 | eBay | Order Earnings (`sales`) is authoritative for fees and labels; promoted-listing fees are sale fees (Line 10), already in `sales.fees`. The Transaction Report is audit detail. |
| 2026-11-12 | Inventory lots from order emails | Create lots only when each item's subtotal can be read or derived from the order email (foreign-currency orders count: their prices give the ratio). Lot costs sum **exactly** to the charge, split by item price ratio (tax, shipping, FX included proportionally). Otherwise skip; the charge stays under Expenses → "Cost of goods without lots". Rules in [features/inventory.md](features/inventory.md#lot-data-rules-books-cleanup). |
| 2026-11-12 | Duplicate items | Merge duplicate items only when their lots come from distinct charges. |
| 2026-11-12 | Sales ↔ lots | Fully refunded sales are never linked (no unit left inventory). |
| 2026-11-12 | Charge/refund pairs | Same merchant + same amount + refund within 90 days → net-zero pair. Pairs reaching into 2024 are left out (a 2025 refund of a 2024 purchase correctly reduces 2025 cost of goods). |
| 2026-11-13 | Review markers | `ai_reviewed` / `owner_reviewed` on transactions, sales and lots; owner-reviewed rows are locked at the database ([supabase-schema.md](supabase-schema.md#review-markers-review_status-added-2026-11-13)). |
| 2026-11-13 | Money outside the bank feed | Payouts that landed in accounts the app doesn't sync are added by hand as `settlement` rows from the platform's payout history and receipt emails (convention in [reconciliation.md](reconciliation.md#manual-entries-for-money-outside-the-bank-feed)). Replaces waiting for statements. |
| 2026-11-13 | Refunds of prior-year sales | Deducted in the year paid (the sale was in that earlier year's income); 2024 not amended. |
| 2026-11-13 | eBay charges to card/bank | `settlement` (platform `ebay`), not an expense: the refund/label/fee they fund is already deducted via the Sales tab. |
| 2026-11-13 | eBay store subscription | Counted from the Transaction Report rows themselves (Line 10). **Store rows only**: no other report row without an order number is counted; the tie-out flags unaccounted rows as ghosts instead. |

## Open questions for the preparer

- Is the Line 1 / Line 2 presentation (gross including full returns, refunds on Line 2) what they want? It matches 1099-K gross.
- Is a few-percent annual timing difference between payouts and recorded sales acceptable with a written explanation?
- Credit card rewards: reduce expenses (current) or exclude?
- After closing 2025: amend (1040-X) or not?

## Where things stand (2026-11-13)

Everything below is merged to `main` and live.

- **Plaid sync:** on-demand and daily cron share `_shared/plaidSync.ts`; settlement classification only on deposit accounts; Phase 1 categorization of 2025–26 spending complete.
- **Sales-based income**, **Part III (traditional)** with lot-based estimates, Dashboard with cost of goods sold separated from expenses and inventory on hand.
- **Year-End Tie-Out:** eBay and Amazon reconcile line by line against their reports (payouts matched to the bank; ghost check); TCGplayer by payout timing; in-person sales by payment method. Status:
  - eBay and Amazon 2026: explained by the report.
  - eBay 2025: one small flag (labels for orders sold in December 2024). Amazon 2025: refunds of 2024 sales, now booked in 2025.
  - TCGplayer: ties apart from December-to-January timing and one cancelled payout (TASKS.md).
  - **Wallet deposits (PayPal, Zelle, Cash App, Venmo) without recorded sales: the main open item** (Phases 2–3).
- **Imports:** every import card is re-upload safe; eBay Transaction Report import fixed (books exactly eBay's Net amount per row).

## Production change history

Counts only; backups of every change were kept privately.

- **2026-11-09** — Legacy iOS category tags re-tagged onto real Schedule C lines; card payments → transfer; wallet cash-outs → settlement; personal cards removed (sync off, rows deleted). Phase 1: every 2025–26 business transaction categorized, batched by merchant with owner approval; category rules for repeat single-category merchants. Plaid: sync logic shared, deposit-account-only settlements, cron made async, old eBay API cron removed, full resync (0 duplicate IDs).
- **2026-11-10** — All remaining income-tagged deposits re-tagged (`settlement` with platform, or `transfer`). Health check: same-day identical charges kept (genuine); suspected cron duplicates were separate accounts. Row-cap bug fixed.
- **2026-11-12** — 57 charge/refund net-zero pairs. Inventory lots created for 2025 and 2026 cost-of-goods charges matched to order emails (each charge's lots sum to the charge). Sales linked to lots in several rounds (oldest units first, presale window, refunded sales excluded). Lot purchase dates backfilled from their charges. Duplicate items merged (no shared charges). `link_sale_to_item` RPC.
- **2026-11-13** — Review markers (migration + backfill of the cleanup work). Split payments columns. TCGplayer: missing payouts added from the payout history, refunds missing from the order import fixed by hand from the order export. Amazon: a mis-tagged payout re-tagged; refunds of 2024 sales added to 2025. eBay: Transaction Report import fixed, existing rows re-keyed, files re-imported (only missing rows added); card/bank charges re-tagged `settlement`; store subscription counted from the report.

## Next

See TASKS.md "Books cleanup": Phase 2 (classify wallet deposits), Phase 3 (missing sales), Phase 4 (missing expenses), Phase 5 (year-end inventory values), Phase 6 (close each year and hand to the preparer).
