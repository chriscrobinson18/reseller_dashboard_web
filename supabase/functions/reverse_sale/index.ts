// reverse_sale — atomically undo a sale (restore lots + delete movements +
// delete linked manual transactions + soft-delete the sale).
//
// Thin wrapper around the `public.reverse_sale(uuid)` RPC, which does the
// real work in a single Postgres transaction with SELECT … FOR UPDATE locks
// on the affected lot rows. See migration 20260623120000_reverse_sale_rpc.sql.
//
// Input  : { sale_id: string }
// Output : { ok: true, lots_restored, transactions_deleted }
// Errors :
//   400 — missing sale_id
//   401 — no/invalid JWT
//   403 — sale belongs to another user (RPC raised `forbidden`)
//   404 — sale_id doesn't exist (RPC raised `sale_not_found`)
//   409 — sale already soft-deleted (RPC raised `already_deleted`; replay guard)
//   500 — anything else

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function err(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return err(401, "Unauthorized");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );

    const body = await req.json().catch(() => ({}));
    const sale_id = body?.sale_id;
    if (!sale_id || typeof sale_id !== "string") {
      return err(400, "sale_id required");
    }

    const { data, error } = await supabase.rpc("reverse_sale", {
      p_sale_id: sale_id,
    });
    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("sale_not_found")) return err(404, "Sale not found");
      if (msg.includes("forbidden")) return err(403, "Forbidden");
      if (msg.includes("already_deleted")) return err(409, "Already deleted");
      return err(500, msg || "rpc failed");
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return err(500, String(e));
  }
});
