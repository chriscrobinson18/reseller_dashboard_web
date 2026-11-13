# Reseller Dashboard (Web)

Web client for a reseller bookkeeping/tax app. Tracks bank transactions, sales, and inventory (FIFO cost lots) and rolls them up into IRS Schedule C categories. Shares one Supabase project/schema with a sibling iOS app (`reseller_dashboard`) — **this is the primary client going forward**; fix bugs here rather than porting them from mobile.

Full knowledge base lives in [`docs/`](docs/README.md) — read it before making non-trivial changes (books work: start at [`docs/books-cleanup-handoff.md`](docs/books-cleanup-handoff.md); production work: [`docs/operations.md`](docs/operations.md)), and **update the relevant doc in the same PR** whenever you change schema, a money-math function, or a feature's behavior. Stale docs are worse than no docs.

## Quick orientation

- Stack: Vite + React 19 + TypeScript, React Router, TanStack React Query, Tailwind, Recharts, `@supabase/supabase-js`.
- `src/lib/supabase.ts` — Supabase client. `src/lib/queries.ts` — reads (React Query hooks). `src/lib/mutations.ts` — all writes. `src/lib/categories.ts` — the 21 Schedule C categories + tax flags. `src/lib/periods.ts` — date-range presets used by every page's period picker.
- Pages (`src/pages/*.tsx`) each own their data fetching inline (not centralized in queries.ts except Inventory) — see [`docs/features/`](docs/features) for what each page does and why.
- RLS scopes all reads by `user_id` automatically; inserts must set `user_id` explicitly (see [`docs/supabase-schema.md`](docs/supabase-schema.md)).
- Tax correctness is the dominant design constraint — see [`docs/categories.md`](docs/categories.md) and the P0 list in [`TASKS.md`](TASKS.md) before touching anything that sums money.

## Dev commands

```bash
npm run dev      # start Vite dev server
npm run build    # tsc -b && vite build
npm run lint     # ESLint
```

Vitest (`npx vitest run`) covers the money math under `src/lib/__tests__/`: categories/bucketing, `scheduleCMath`, `salesIncome`, `partIII`, `tieOut`, `csvExport`, `saleProfit`, `lotCost`, `paymentMethods`, `fetchAll`, and the pure edge-function parsers in `supabase/functions/_shared/` (`csvOrderAggregate`, `ebayTransactionReport`). Add tests when you touch covered files; don't add brand-new test files for uncovered areas unless explicitly asked.

Deployed on Vercel (`vercel.json` at repo root).

## Key gotchas

- **Public repo** — never put amounts, merchant names, account/order numbers or personal names in commits, docs or code comments.

- **Tailwind v4** — uses `@tailwindcss/vite` plugin; there is no `tailwind.config.js`. All theme customization goes in CSS, not a config file.
- **React Router v7** (not v6) — uses the v7 API. Don't use v6-only patterns.
- **`src/lib/types.ts`** — shared TypeScript interfaces and types; check here before defining new ones.
- **`src/lib/utils.ts`** — shared utility functions.

## Review markers (AI vs owner)

`transactions`, `sales` and `inventory_lots` have `review_status`. **Any AI-made data write must set `review_status = 'ai_reviewed'` and `reviewed_at = now()` on the rows it creates or changes.** Rows marked `owner_reviewed` are confirmed by the owner. A database trigger blocks direct SQL from changing their category, links, amounts or lot fields. Don't try to work around it; list those rows for the owner instead. See `docs/supabase-schema.md` → Review markers.

## Shared UI components

Reuse these before building new ones:

- `Layout` — app shell with nav
- `Modal` / `SlideOver` — overlay primitives
- `ConfirmDialog` — confirmation prompt
- `PeriodPicker` — date-range selector (wraps `periods.ts` presets)
- `CategoryBadge` — Schedule C category pill
- `ItemPicker` — inventory item selector
- `TransactionInventorySection` — transaction ↔ inventory link UI

Modal implementations live in `src/components/modals/` (AddItem, AddLot, AddTransaction, EditItem, EditLot, EditSale, LinkSaleToItem, RecordSale).

## Doc maintenance rule

When you add/change a table, edge function, mutation, or page behavior: update the matching file under `docs/` in the same change. If no file fits, add one and link it from `docs/README.md`.

## Subagent model routing

Pass `model:` on every `Agent` call. Defaults to keep main-session (Opus) tokens low:

| Agent / task                                              | Model    |
| --------------------------------------------------------- | -------- |
| `Explore` (file/symbol lookup)                            | `haiku`  |
| `general-purpose` research, log/diff/grep summarization   | `haiku`  |
| `Plan`, single-file refactors, doc edits                  | `sonnet` |
| `superpowers:code-reviewer` on diffs <500 lines           | `sonnet` |
| `superpowers:code-reviewer` on diffs ≥500 lines, security | `opus`   |
| Money-math, Schedule C category, RLS, migration work      | `opus`   |
| Final synthesis / orchestration in main session           | `opus`   |

Rules:
- Default to the cheapest tier that can plausibly do the job; upgrade only on failure or when the task touches tax correctness, money, or schema.
- Parallel fan-out (`superpowers:dispatching-parallel-agents`) should be Haiku/Sonnet unless each leg requires Opus-level reasoning.
- Never downshift the orchestrator mid-task — model overrides apply to spawned subagents, not the current session.

### Thinking effort

Trigger words escalate extended-thinking budget (in any prompt, including subagent prompts): `think` < `think hard` < `think harder` < `ultrathink`. More thinking ≠ better — it costs tokens and latency.

| Task shape                                                           | Effort        |
| -------------------------------------------------------------------- | ------------- |
| Lookup, formatting, mechanical edits, single-file CRUD               | none          |
| Multi-file refactor, choosing between 2-3 known approaches           | `think`       |
| Tax/money/schema design, debugging non-obvious bugs, RLS reasoning   | `think hard`  |
| Architectural decisions, multi-system tradeoffs, plan for new feature| `think harder`|
| Reserve `ultrathink` for genuinely novel/ambiguous problems          | rare          |

### Explore breadth

`Explore` takes a breadth hint — use the smallest that will find the answer:

- `quick` — one targeted lookup (known file/symbol)
- `medium` — moderate exploration (a feature spans a few files)
- `very thorough` — only when naming conventions are unknown or the answer could live anywhere

### Combining levers

Pair model + effort to the task, don't max both reflexively. Examples:
- "Find where `categories.ts` is imported" → Haiku, no thinking, `quick`
- "Refactor the period picker to share state across pages" → Sonnet, `think`, `medium`
- "Audit the FIFO cost-lot consumption for off-by-one errors" → Opus, `think hard`, `very thorough`
