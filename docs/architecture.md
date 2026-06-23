# Architecture

## Stack

- **Build/dev**: Vite 8, TypeScript, React 19
- **Routing**: `react-router-dom` v7, plain `BrowserRouter`
- **Data fetching**: `@tanstack/react-query` v5 — every page/component fetches via `useQuery`, mutates via `useMutation`, and invalidates the relevant query key(s) on success. No global store; React Query's cache *is* the app state.
- **Backend**: Supabase (Postgres + Auth + Edge Functions + Storage), accessed via `@supabase/supabase-js`. RLS does per-user scoping — see [supabase-schema.md](supabase-schema.md).
- **Styling**: Tailwind v4 (via `@tailwindcss/vite`), no component library — bespoke Tailwind classes in every component.
- **Charts**: Recharts (`BarChart` on the Dashboard).
- **Icons**: `lucide-react`.

## App shell (`src/App.tsx`)

- Single `QueryClient` (`staleTime: 2min`, `retry: 1`) for the whole app.
- Auth state via `supabase.auth.getSession()` + `onAuthStateChange` subscription, held in local `useState<Session | null | undefined>` (`undefined` = still loading).
- Unauthenticated → only `/login` is reachable. Authenticated → `Layout` wraps the four main routes: `/dashboard`, `/sales`, `/inventory`, `/expenses`. No nested routes, no route-level code splitting.

## File layout

```
src/
  lib/
    supabase.ts    — Supabase client singleton (env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
    types.ts       — hand-written TS interfaces for Transaction, Sale, Item, InventoryLot (NOT generated from schema — keep in sync manually)
    categories.ts  — CATEGORIES array + getCategoryDef() — see categories.md
    periods.ts     — PeriodPreset union + getPeriodRange() — date math for the period picker, shared by every page
    queries.ts     — only inventory reads live here (useItems, fetchItemsWithLots) + derived helpers (itemUnitsInStock, itemAvgCost)
    mutations.ts   — ALL writes for items/lots/transactions/sales, mirrors iOS SupabaseClient.swift intentionally
    utils.ts       — formatUSD, formatDate/formatShortDate/formatMonthYear, monthKey, clsx
  components/
    Layout.tsx, Modal.tsx, SlideOver.tsx, ConfirmDialog.tsx, PeriodPicker.tsx, CategoryBadge.tsx, ItemPicker.tsx
    TransactionInventorySection.tsx — COGS transaction ↔ inventory lot linking UI, used inside the Expenses detail panel
    modals/ — one modal per create/edit flow (AddItemModal, AddLotModal, AddTransactionModal, EditItemModal, EditLotModal, EditSaleModal, LinkSaleToItemModal, RecordSaleModal)
  pages/
    LoginPage.tsx, DashboardPage.tsx, ExpensesPage.tsx, SalesPage.tsx, InventoryPage.tsx
```

**Inconsistency to be aware of**: Dashboard and Expenses each define their *own* local `fetchTransactions`/`fetchSales` functions inline in the page file rather than importing from `queries.ts`. Sales page does the same. Only inventory reads are centralized in `queries.ts`. If you add a new transaction/sale query, check whether an equivalent already exists in the page you're editing before adding another — and consider migrating shared fetch logic into `queries.ts` rather than adding a fourth copy.

## State/data-fetching conventions

- Query keys: `['transactions', start, end]`, `['sales', start, end]`, `['items']`. Mutations invalidate by key prefix (e.g. `qc.invalidateQueries({ queryKey: ['transactions'] })`) so any open page refetches.
- Soft delete is the norm: `items`, `inventory_lots`, `sales` use a `deleted_at` timestamp column + `.is('deleted_at', null)` filters on read. `transactions` is hard-deleted (see `deleteTransaction` in mutations.ts) — FK `ON DELETE SET NULL` unlinks any inventory lot pointed at it.
- Money is stored as `number` (not cents, not decimal strings) straight from Postgres `numeric` columns. Sign convention: `transactions.amount` is **signed** (negative = expense, positive = income); `sales.sale_price`/`fees`/`shipping_cost` are **unsigned magnitudes** — see [data-flows.md](data-flows.md) for how these get combined.
