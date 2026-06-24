# Supabase Edge Functions

Source-of-truth copies of edge functions deployed to the shared Supabase project (`qmizmnbzergqbpgyqseg`) live here. Each function has its own directory containing `index.ts` and `index.test.ts` (Deno test file).

## Why these are checked in

Edge functions are shared with the iOS app (`reseller_dashboard`). When this repo fixes a bug in a function, the fixed source is committed here so the change is reviewable in git and the iOS team can pull the same version. We commit functions opportunistically — only those touched in a given pass. Untouched functions (`plaid_*`, `import_marketplace_csv`, …) ship from their existing deployed versions until a separate pass brings them into the repo.

## Running tests locally

Each `index.test.ts` is a Deno test that hits a **local Supabase stack**. Tests do not run against the production project.

```bash
# Start the local stack (first time: prints anon + service role keys).
supabase start

# Export the printed keys.
export SUPABASE_URL=http://127.0.0.1:54321
export SUPABASE_ANON_KEY=...
export SUPABASE_SERVICE_ROLE_KEY=...

# Serve the function you want to test.
supabase functions serve <function_name> --no-verify-jwt=false

# In another terminal, run the test.
deno test --allow-env --allow-net supabase/functions/<function_name>/index.test.ts
```

Tests print a skip-message and exit 0 if the env vars are missing, so they don't fail noisily for someone running `deno test` without the local stack.

## Deploying

Deploys go through the Supabase MCP `deploy_edge_function` tool or the CLI:

```bash
supabase functions deploy <function_name>
```

When a fix lands in `index.ts`, deploy before committing so the live function and the committed source stay in sync.
