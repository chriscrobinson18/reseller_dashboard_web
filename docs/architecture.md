# Architecture

## Stack

- **Build/dev**: Vite 8, TypeScript, React 19
- **Routing**: `react-router-dom` v7, plain `BrowserRouter`
- **Data fetching**: `@tanstack/react-query` v5 — every page/component fetches via `useQuery`, mutates via `useMutation`, and invalidates the relevant query key(s) on success. No global store; React Query's cache *is* the app state.
- **Backend**: Supabase (Postgres + Auth + Edge Functions + Storage), accessed via `@supabase/supabase-js`. RLS does per-user scoping — see [supabase-schema.md](supabase-schema.md).
- **Styling**: Tailwind v4 (via `@tailwindcss/vite`), no component library — bespoke Tailwind classes in every component.
- **Charts**: Recharts (`BarChart` on the Dashboard).
- **Icons**: `lucide-react`.
- **Tests**: Vitest + happy-dom + Testing Library for the client (`npx vitest run`, files under `src/**/__tests__/`; shared edge-function parsers are tested from there too). Deno tests via local Supabase for the committed edge functions ([`supabase/functions/<name>/index.test.ts`](../supabase/functions/), see [`supabase/functions/README.md`](../supabase/functions/README.md)).

## App shell (`src/App.tsx`)

- Single `QueryClient` (`staleTime: 2min`, `retry: 1`) for the whole app.
- Auth state via `supabase.auth.getSession()` + `onAuthStateChange` subscription, held in local `useState<Session | null | undefined>` (`undefined` = still loading).
- Unauthenticated → only `/login` is reachable. Authenticated → `Layout` wraps the main routes: `/dashboard`, `/sales`, `/bundles`, `/inventory`, `/trades`, `/breakdowns`, `/expenses`, `/settings`. No nested routes, no route-level code splitting.
- `Layout` shows a sidebar at `md`+ and a bottom tab bar below `md`. Responsive rules are in [mobile-layout.md](mobile-layout.md).

## File layout

```
src/
  lib/                — pure logic + data access (most of it unit-tested)
    supabase.ts       — client singleton (env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
    types.ts          — hand-written TS interfaces (NOT generated from the schema — keep in sync manually)
    categories.ts     — CATEGORIES, resolveCategory, bucketTransaction, isSaleDerivedTransaction (see categories.md)
    salesIncome.ts    — Schedule C income/fees/shipping from sales rows
    scheduleCMath.ts  — KPI row, Schedule C breakdown, monthly chart
    partIII.ts        — Part III (traditional) + lot-based inventory on hand / change
    tieOut.ts, tieOutData.ts — Year-End Tie-Out math and its queries
    csvExport.ts      — Transactions CSV + Schedule C Summary CSV
    csvReturns.ts     — CSV return detection/matching
    saleProfit.ts     — per-sale COGS / net revenue / profit
    lotCost.ts, lotAdjustments.ts, boxAllocation.ts — lot basis, cost adjustments, breakdown allocation
    paymentMethods.ts, salePlatforms.ts — payment rails (+ split payments) and the sale platform list
    fetchAll.ts       — fetchAllRows: pages past PostgREST's 1000-row cap
    periods.ts        — PeriodPreset + getPeriodRange (shared by every page)
    queries.ts        — shared React Query hooks (inventory, bundles, trades, lot valuation…)
    mutations.ts      — ALL writes; mirrors iOS SupabaseClient.swift intentionally
    transactionSearch.ts, categoryPalette.ts, utils.ts
    __tests__/        — Vitest specs (13 files: categories/bucketing, scheduleCMath, salesIncome, partIII, tieOut,
                        csvExport, csvOrderAggregate, ebayTransactionReport, fetchAll, lotCost, paymentMethods, saleProfit, smoke)
  components/         — Layout, Modal, SlideOver, ConfirmDialog, PeriodPicker, CategoryBadge/CategoryDropdown, ItemPicker,
                        PartIIICard, TieOutCard, ReviewMarker, ReceiptSection, PaymentMethodInput, the *DetailSlideOver panels…
    modals/           — one modal per create/edit flow (record/edit sale, bundle, trade, return, lots, items, transactions…)
  pages/              — Login, Dashboard, Sales, Bundles, Inventory, Trades, Breakdowns, Expenses, Settings (+ settings/)

supabase/
  migrations/         — migrations since mid-2026 (some applied by SQL, see operations.md#migrations)
  functions/          — 14 edge functions (see supabase-schema.md) + _shared/ (plaidSync, salesImport,
                        csvOrderAggregate, ebayTransactionReport — the last three are pure and tested from src/lib/__tests__)
    README.md         — local-stack Deno test workflow
scripts/              — generate_shortcut.py (Apple Shortcuts quick entry)
tampermonkey/         — tcgplayer-export.user.js (TCGplayer order export → import_tcgplayer_orders)
```

**Inconsistency to be aware of**: Dashboard and Expenses each define their *own* local `fetchTransactions`/`fetchSales` functions inline in the page file rather than importing from `queries.ts`. Sales page does the same. Only inventory reads are centralized in `queries.ts`. If you add a new transaction/sale query, check whether an equivalent already exists in the page you're editing before adding another — and consider migrating shared fetch logic into `queries.ts` rather than adding a fourth copy.

## State/data-fetching conventions

- Query keys: `['transactions', start, end]`, `['sales', start, end]`, `['items']`. Mutations invalidate by key prefix (e.g. `qc.invalidateQueries({ queryKey: ['transactions'] })`) so any open page refetches.
- Soft delete is the norm: `items`, `inventory_lots`, `sales` use a `deleted_at` timestamp column + `.is('deleted_at', null)` filters on read. `transactions` is hard-deleted (see `deleteTransaction` in mutations.ts) — FK `ON DELETE SET NULL` unlinks any inventory lot pointed at it.
- Money is stored as `number` (not cents, not decimal strings) straight from Postgres `numeric` columns. Sign convention: `transactions.amount` is **signed** (negative = expense, positive = income); `sales.sale_price`/`fees`/`shipping_cost` are **unsigned magnitudes** — see [data-flows.md](data-flows.md) for how these get combined.
