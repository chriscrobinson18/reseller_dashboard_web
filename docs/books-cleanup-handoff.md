# Books cleanup — session handoff (start here)

Last updated 2026-11-09. Read this, then [`TASKS.md`](../TASKS.md) "🧹 Books Cleanup", then [`bookkeeping-routine.md`](bookkeeping-routine.md). This repo is **public**: never put amounts, merchant names, account numbers or personal names in commits, docs or code comments. Running totals belong in chat only.

## Working rules (owner's standing instructions)

- **Branch:** `claude/books-cleanup-phase1` (all work since 2026-11-09). Push there; no PR unless asked.
- **Approval first:** explicit owner approval before any production data write, migration or edge-function deploy. Propose in batches with a one-line reason per item; flag anything ambiguous.
- **Before every data write:** back up the affected rows (id + old values) outside git, then use a guarded `UPDATE` that only changes a row if its current values still match the backup. Re-query and reconcile counts and totals afterwards.
- **Before every edge-function deploy:** `supabase functions download <name>` and diff it against the repo; keep `npm:plaid@47.0.0` pinned and JWT verification as it was. Re-download after the deploy and confirm it's byte-identical.
- **Validate every number twice:** recompute totals a second way before reporting (the owner's preference).
- Rows sharing date + amount + merchant are genuine repeat charges: categorize them, never delete them.
- 2024 is out of scope: ignore its rows entirely.

## How to reach production from a cloud session

The Supabase Management API host is proxy-authenticated (no key needed):

```bash
# read-only SQL (safe for investigation)
python3 -c 'import json,sys;print(json.dumps({"query":sys.stdin.read()}))' \
  | curl -sS -X POST https://api.supabase.com/v1/projects/<project-ref>/database/query/read-only \
      -H 'Content-Type: application/json' -d @-
# writes: same, without /read-only (owner approval first)
```

Edge functions: `SUPABASE_ACCESS_TOKEN=<any dummy> npx supabase@latest functions download|deploy <name> --project-ref <ref> --use-api` (deploy needs `--yes` in agent mode, and only after approval). The project ref is in `src/lib/supabase.ts` / the deploy docs. To type-check Deno functions, copy them plus `_shared/` into a scratch folder with `{"nodeModulesDir":"auto"}` in a `deno.json` and run `npx deno@2.5.6 check`.

Scratchpad backups and analysis scripts from earlier sessions are **gone** with their containers; only git and the database persist.

## Decisions made (2026-11-09)

| Topic | Decision |
|---|---|
| Income | **From the Sales tab only** (`sales` rows). Bank deposits never carry income once their sales exist. |
| Marketplace deposits (eBay, Amazon, TCGplayer) | Always `settlement`. Income for a month whose sales aren't imported yet is missing until the import happens. |
| Other income-tagged deposits | Each must eventually have matching recorded sales, then becomes `settlement`. Until then it stays `payout` (counted) so nothing disappears. |
| Settlements | **Insurance only:** the year-end tie-out proves every sale is recorded. Per-deposit linking was dropped (not required by preparers). |
| Inventory method | **Traditional (§471):** Part III = beginning + purchases − ending, with stored year-end values. |
| eBay fees | Promoted-listing fees are sale fees (Line 10), already inside `sales.fees` from Order Earnings. |
| eBay authority | Order Earnings report (`sales`) is authoritative for fees and labels; the Transaction Report (`csv_import`) is audit detail. Re-imports backfill. |
| Card refunds | Re-tag to the original purchase's category (usually cost of goods) so they net. |
| Card cash-back | Custom category "Credit Card Rewards" (Line 27a), a reduction of expenses. |
| Custom categories added | Memberships, Credit Card Rewards, Tech & Dev Tools (all Line 27a). |

## What's done and live

- Plaid sync: on-demand and daily cron share `supabase/functions/_shared/plaidSync.ts`; settlement classification only on deposit accounts. Cron job `plaid-sync-scheduled-daily` (async `net.http_post`). Old eBay API cron removed.
- Phase 1 (categorize 2025–26 spending) complete.
- `sales.shipping_charged` migration applied; TCGplayer buyer-paid shipping moved there. Re-imports via `_shared/salesImport.ts` (never un-delete, never reset inventory/return fields). Both import functions deployed.

## What's on the branch but NOT live

| Item | State |
|---|---|
| Sales-based Schedule C income (`src/lib/salesIncome.ts`, `isSaleDerivedTransaction`, Dashboard + both CSV exports, trade income legs) | Built, tested, committed. Takes effect when the branch is merged (Vercel deploys `main`). |
| Part III, traditional method (`src/lib/partIII.ts`, `PartIIICard`, Summary CSV Part III for "Last Year") | Built, tested, committed. **Migration `supabase/migrations/20261109150000_inventory_valuations.sql` NOT applied**; apply it (with approval) before merging, or the Part III card errors. |
| Year-End Tie-Out (step 4) | **In progress.** See below. |

Test suite: `npx vitest run` (106 passing at handoff). Pre-existing lint errors in `CSVGroupDetailSlideOver.tsx` and `SettingsPage.tsx` aren't from this work.

## Next: Year-End Tie-Out (step 4)

**Status:** `src/lib/tieOut.ts` is written and type-checks, but it is **untested, not run against real data, and not wired into any UI.**

**Purpose:** prove every sale is recorded. The owner's words: settlements are "insurance that all sales are recorded".

**What `tieOut.ts` provides (pure functions):**
1. `computeTieOut(sales, settlementDeposits)`: per platform, sales count / gross / fees / shipping / refunds / net (each sale's stored `net_payout`, because platform formulas differ) vs. settlement deposits, with the difference and monthly rows. Flags:
   - deposits with no recorded sales
   - months with deposits but no sales
   - a difference above `max($50, 5% of net)`
2. `incomeDepositsNeedingSales(rows)`: bank deposits still tagged `payout` that aren't sale/bundle/trade-linked or net-zero. The owner rule says each needs matching sales.
3. `compareEbaySources(ebaySales, ebayCsvRows)`: per order, Order Earnings vs. Transaction Report:
   - fields: gross, fees incl. advertising, shipping labels, refunds
   - also lists orders that exist on only one side
   - purpose: target re-imports before trusting a backfill

**Remaining work:**
1. **Unit tests** for `tieOut.ts` (`src/lib/__tests__/tieOut.test.ts`).
2. **Dry run on real data (read-only).** Sanity-check per platform and year:
   - Settlement deposits: transactions with `record_type = 'settlement'` or category `settlement`, amount > 0, source ≠ `csv_import`, dated in the year, keyed by `transactions.platform`.
   - eBay CSV rows: `source = 'csv_import'` and `platform = 'ebay'`, dated year ± ~45 days. The order number is in `notes`.
   - Expectations from earlier checks:
     - eBay CSV `payout` rows equal the sale price for most orders; the CSV under-reports label costs compared with Order Earnings.
     - October onward 2026 sales aren't imported yet, so those months should flag.
     - One grading-company sale deposit has no sale recorded, so its platform should flag "deposits with no recorded sales".
3. **`TieOutCard`** on the Dashboard:
   - its own tax-year selector, like `PartIIICard` (never period-scoped)
   - fetches the year's sales, deposits and eBay CSV rows
   - shows: a platform table (table on `md+`, stacked cards on phones; see `docs/mobile-layout.md`), an expandable month view, the income-deposits list, and the eBay mismatch summary plus list
4. **Docs:** add a "Year-End Tie-Out" section to `docs/features/dashboard.md`; update the tooling note in `bookkeeping-routine.md` and the step-4 item in TASKS.md.
5. Then ask the owner about: **applying the inventory migration**, **merging the branch**, and Phase 2.

## After the tie-out

- **Owner's data load (before filing):** all sales for all years (P2P / cash / auction / Whatnot / Facebook, plus the remaining marketplace months) and inventory lots. Then year-end inventory values (2024 from the filed return, 2025, 2026).
- **Phase 2:** convert income-tagged deposits to `settlement` once the tie-out shows their sales.
- **Phase 6:** Schedule C per line for 2025 and 2026, compare 2025 with the filed return, hand off to the CPA (1040-X decision).
- **Small open items in TASKS.md:**
  - TCGplayer refund amounts aren't imported
  - tabled Amazon purchase review (order-history export)
  - one manual "Sync Now" click to verify the on-demand sync
