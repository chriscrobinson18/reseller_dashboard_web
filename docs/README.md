# Docs index

Knowledge base for the Reseller Dashboard web app, meant to be read by humans and injected as context for AI agents before they implement changes. Keep these current — see the maintenance rule in [`/CLAUDE.md`](../CLAUDE.md).

- [architecture.md](architecture.md) — stack, app shell, routing, state/data-fetching conventions, file layout, test infra
- [supabase-schema.md](supabase-schema.md) — tables, columns, RLS, edge functions, RPCs, what's NOT in this repo
- [categories.md](categories.md) — the 21 Schedule C categories, tax flags (`isExcluded`, `mealsHalf`), the `bucketTransaction` helper, known correctness gaps
- [data-flows.md](data-flows.md) — cross-cutting business logic: `bucketTransaction`, record/edit/delete sale, FIFO COGS, returns
- features/
  - [dashboard.md](features/dashboard.md)
  - [expenses.md](features/expenses.md)
  - [sales.md](features/sales.md)
  - [inventory.md](features/inventory.md)
  - [settings.md](features/settings.md)
- [`../supabase/functions/README.md`](../supabase/functions/README.md) — local-stack workflow for the committed edge functions and Deno tests

Related: [`/TASKS.md`](../TASKS.md) tracks open work and known bugs (P0 tax-correctness items especially). Docs here describe *current* behavior, including known-buggy behavior — check TASKS.md to see if something documented here is slated to change.
