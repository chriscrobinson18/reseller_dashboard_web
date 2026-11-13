# Operations runbook

How to work against production safely: data writes, migrations, edge-function deploys, scheduled jobs and releases. Rules here came from real incidents; each one says why. Public repo: no keys, amounts or account numbers.

## Releases

- **Vercel deploys `main`.** Work happens on a feature branch; a release is a fast-forward of `main` to that branch once the owner approves. Run `npx vitest run` and `npm run build` first.
- Database changes (migrations, edge functions) that the new app code depends on go out **before** the app release. A purely additive column can ship first and be harmless to old code.

## Reaching production from a cloud session

The Supabase Management API host is proxy-authenticated (no key needed):

```bash
# read-only SQL (investigation)
python3 -c 'import json,sys;print(json.dumps({"query":sys.stdin.read()}))' \
  | curl -sS -X POST https://api.supabase.com/v1/projects/<project-ref>/database/query/read-only \
      -H 'Content-Type: application/json' -d @-
# writes: same endpoint without /read-only (owner approval first)
```

The project ref is in `src/lib/supabase.ts`. The REST host (`<ref>.supabase.co/rest/v1`) is also proxy-authenticated, so the app's own query code (`src/lib/tieOutData.ts`, `fetchAllRows`) can be run under Vitest with `NODE_USE_ENV_PROXY=1` to check a feature against live data read-only.

Quoting pitfall: when wrapping SQL in another language, don't use Postgres `$$…$$` quoting around a regex that ends in `$` (the anchor merges into the delimiter). Read the SQL from a file instead.

## Data writes (production)

1. **Owner approval first** for any production write, migration or deploy. Propose in batches with a one-line reason per item.
2. **Before writing:** check every target row is matched exactly once, isn't `owner_reviewed` (the database refuses those anyway, see [supabase-schema.md](supabase-schema.md#review-markers-review_status-added-2026-11-13)), and has no links you'd break (inventory lots, net-zero pairs, sale/bundle links). Keep a backup of id + old values outside git.
3. **Write guarded:** an `UPDATE … WHERE` that only matches rows whose current values are the ones you checked; inserts carry a `not exists` guard so a retry can't duplicate.
4. **Mark AI work:** every row an assistant creates or changes gets `review_status = 'ai_reviewed'`, `reviewed_at = now()` and a note citing the evidence.
5. **Re-query afterwards** and reconcile counts and totals, computed a second way (the owner's standing preference).
6. Rows sharing date + amount + merchant are genuine repeat charges: categorize them, never delete them.
7. Constraint reminders: `transactions.type` allows only `inventory | fee | shipping | other`.

## Migrations

- Files live in `supabase/migrations/`. Recent ones were applied with the Management API (`begin; …; commit;`) rather than `supabase db push`, so **`supabase_migrations.schema_migrations` doesn't list them**. `supabase db push` would try to re-run them; repair the history first if you switch to it.
- The two `box_openings` migrations (`20260803120000`, `20260803130000`) are in the same situation.
- **Data migrations** (e.g. `20261113140000_ebay_csv_rekey.sql`): dry-run the exact expression as a read-only `SELECT` against production first and compare with what the code will produce.

## Edge functions

**Always download the live source and diff it before deploying.** Production has drifted from the repo before (a deploy from the repo once would have silently removed a sync step that only existed live).

```bash
SUPABASE_ACCESS_TOKEN=sbp_<40 zeros> npx --yes supabase@<pinned version> functions download <name> --project-ref <ref> --use-api
# diff against supabase/functions/<name>/ and _shared/, then
SUPABASE_ACCESS_TOKEN=sbp_<40 zeros> npx --yes supabase@<pinned version> functions deploy <name> --project-ref <ref> --use-api
# then download again and confirm it is byte-identical to the repo
```

- `--use-api` needs a recent CLI (2.122 worked on 2026-11-13; 2.45 lacks the flag). Use a version at least two weeks old.
- Keep `verify_jwt` as it was (the deploy reports it; check after).
- **Pin `npm:plaid@47.0.0`** in every Plaid function. `plaid@51` (2026-11-06) removed `Configuration` / `PlaidApi` / `PlaidEnvironments`, so any redeploy on `@latest` fails at load and breaks bank sync.
- `plaid_sync_transactions` and `plaid_sync_scheduled` share `_shared/plaidSync.ts`: after changing it, **redeploy both**.
- Shared parsers that the web tests import (`_shared/ebayTransactionReport.ts`, `_shared/csvOrderAggregate.ts`, `_shared/salesImport.ts`) must stay free of Deno/npm imports.
- Production also runs functions that aren't in this repo (eBay OAuth, `plaid_create_link_token`, `plaid_oauth_redirect`, `plaid_backfill_*`, …), presumably from the iOS repo. Some import `npm:plaid@latest` and will break on their next deploy until pinned (TASKS.md).
- Type-check Deno functions by copying them plus `_shared/` into a scratch folder with `{"nodeModulesDir":"auto"}` in a `deno.json` and running `npx deno@2.5.6 check`.

## Scheduled jobs (pg_cron)

- `plaid-sync-scheduled-daily`: 08:00 UTC, calls `plaid_sync_scheduled` with async `net.http_post` and a 5-minute timeout (migration `20261109120000`). The old synchronous call gave up after 5 seconds and logged every run as failed although the sync completed.
- The old eBay API sync job was removed (`20261109130000`): eBay data now comes only from CSV uploads, so missing months must be re-imported by hand.

## Row cap

PostgREST returns at most 1000 rows per request, silently. Every list query that can exceed that must page through [`fetchAllRows`](../src/lib/fetchAll.ts) with a stable `…, id` order. Before this was fixed (2026-11-10), full-year views showed only the most recent 1000 rows.
