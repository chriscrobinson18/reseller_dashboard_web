// shortcut_record_sale — quick sale entry from Apple Shortcuts.
// Auth: token lookup via service role (no JWT required from caller).
// No FIFO depletion — sale is created unlinked (item_id = null).
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
    const { shortcut_token, item_name, quantity, sale_price, payment_method } = body;

    if (!shortcut_token) return json(401, { error: "Missing shortcut_token" });
    if (!item_name?.trim()) return json(400, { error: "Missing field: item_name" });
    if (!quantity || Number(quantity) <= 0) return json(400, { error: "Missing field: quantity (must be > 0)" });
    if (sale_price == null || isNaN(Number(sale_price))) return json(400, { error: "Missing field: sale_price" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("shortcut_token", shortcut_token)
      .maybeSingle();

    if (!profile) return json(401, { error: "Invalid shortcut token" });

    const soldAt = new Date().toISOString().split("T")[0];
    const netPayout = Number(sale_price);

    const { data: sale, error: saleError } = await supabase
      .from("sales")
      .insert({
        user_id: profile.id,
        item_id: null,
        item_name: item_name.trim(),
        quantity: Number(quantity),
        sale_price: netPayout,
        payment_method: payment_method ?? null,
        source: "manual",
        platform: "manual",
        sold_at: soldAt,
        fees: 0,
        shipping_cost: 0,
        net_payout: netPayout,
        inventory_status: "ok",
        return_status: "none",
        refunded_quantity: 0,
      })
      .select("id")
      .single();

    if (saleError) throw saleError;
    return json(200, { success: true, sale_id: sale.id });
  } catch (err) {
    return json(500, { error: String(err) });
  }
});
