# Docs index

Knowledge base for the Reseller Dashboard web app, for humans and for AI agents before they change anything. Keep it current: see the maintenance rule in [`/CLAUDE.md`](../CLAUDE.md). This repo is **public** — no amounts, merchant names, account or order numbers, or personal names in any doc.

**Start here**
- **[books-cleanup-handoff.md](books-cleanup-handoff.md)** — 2025–26 books cleanup: working rules, the **decision log**, where things stand, production change history
- [`/TASKS.md`](../TASKS.md) — open work only (action items); history lives in these docs

**How the money works**
- [categories.md](categories.md) — Schedule C categories, custom categories in use, `bucketTransaction`, sales-based income, returns
- [data-flows.md](data-flows.md) — cross-cutting logic: record/edit/delete sale, bundles, split payments, FIFO COGS, lot cost adjustments, breakdowns, returns, trades
- [reconciliation.md](reconciliation.md) — per platform (eBay, Amazon, TCGplayer, wallets): how money moves, what reaches Schedule C, how the tie-out proves completeness, manual entries for money outside the bank feed
- [bookkeeping-routine.md](bookkeeping-routine.md) — monthly and year-end routine, what goes to the preparer

**System**
- [architecture.md](architecture.md) — stack, app shell, file layout, data-fetching conventions, tests
- [supabase-schema.md](supabase-schema.md) — tables, columns, RLS, review markers, edge functions, RPCs, storage
- [operations.md](operations.md) — releases, production access, data-write rules, migrations, edge-function deploys, cron, row cap
- [mobile-layout.md](mobile-layout.md) — phone layout rules (nav, tables→cards, bottom-sheet modals, no horizontal scroll)
- [`../supabase/functions/README.md`](../supabase/functions/README.md) — local-stack workflow for edge functions and Deno tests

**Pages** (`features/`)
- [dashboard.md](features/dashboard.md) — KPIs, Schedule C breakdown, CSV exports, Part III, Year-End Tie-Out
- [sales.md](features/sales.md) · [expenses.md](features/expenses.md) · [inventory.md](features/inventory.md) (incl. lot data rules) · [breakdowns.md](features/breakdowns.md) · [settings.md](features/settings.md) (imports, Plaid, Shortcuts)

**Procedures and designs**
- [sop-card-inventory.md](sop-card-inventory.md) — standard procedure for card inventory
- [`superpowers/specs/`](superpowers/specs/) and [`superpowers/plans/`](superpowers/plans/) — design specs and implementation plans for past features (historical; current behavior is in the docs above)

Docs describe *current* behavior, including known gaps; TASKS.md says what is slated to change.
