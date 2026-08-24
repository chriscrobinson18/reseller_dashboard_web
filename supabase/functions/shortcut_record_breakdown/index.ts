// shortcut_record_breakdown — quick breakdown entry from Apple Shortcuts.
// Auth: token lookup via service role (no JWT required from caller).
// Creates an incomplete box_openings row (source_lot_id = null, box_cost = null).
// The user completes it in the web app via "Breakdown Inventory".
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { shortcut_token, item_name, quantity } = body;

    if (!shortcut_token) return json(401, { error: "Missing shortcut_token" });
    if (!item_name?.trim()) return json(400, { error: "Missing field: item_name" });
    if (!quantity || Number(quantity) <= 0) return json(400, { error: "Missing field: quantity (must be > 0)" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("shortcut_token", shortcut_token)
      .maybeSingle();

    if (!profile) return json(401, { error: "Invalid shortcut token" });

    const openedAt = new Date().toISOString().split("T")[0];

    const { data: opening, error: openingError } = await supabase
      .from("box_openings")
      .insert({
        user_id: profile.id,
        box_name: item_name.trim(),
        quantity: Number(quantity),
        opened_at: openedAt,
        source_lot_id: null,
        box_cost: null,
        allocation_method: null,
        transaction_id: null,
      })
      .select("id")
      .single();

    if (openingError) throw openingError;
    return json(200, { success: true, box_opening_id: opening.id });
  } catch (err) {
    return json(500, { error: String(err) });
  }
});
