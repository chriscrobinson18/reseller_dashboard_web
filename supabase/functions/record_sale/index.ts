// record_sale — inserts a manual sale row and FIFO-depletes inventory_lots.
//
// Contract note: this function does NOT persist `fees`, `shipping_cost`, or
// `net_payout`. Those fields are written by the client wrapper (`recordSale`
// in src/lib/mutations.ts) via a follow-up update on the sales row, and the
// linked payout/fee/shipping `transactions` rows are also created client-side
// (`createSaleTransactions`). If you change this function to accept those
// fields, drop the corresponding client `.update()` block.
//
// See docs/superpowers/specs/2026-06-23-p0-tax-correctness-design.md § C
// (P0 item 6) for the verify-don't-rewrite rationale.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      {
        global: {
          headers: {
            Authorization: req.headers.get("Authorization") ?? "",
          },
        },
      }
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401 }
      );
    }

    const body = await req.json();
    const {
      item_id,
      quantity,
      sale_price,
      platform,
      sold_at,
      source = "manual",
      external_order_id,
    } = body;

    if (!item_id || !quantity || quantity <= 0 || sale_price == null) {
      return new Response(
        JSON.stringify({ error: "Invalid input" }),
        { status: 400 }
      );
    }

    /* Insert sale */
    const { data: sale, error: saleError } = await supabase
      .from("sales")
      .insert({
        user_id: user.id,
        item_id,
        quantity,
        sale_price,
        platform,
        sold_at: sold_at ?? new Date().toISOString(),
        source,
        external_order_id,
        inventory_status: "ok",
      })
      .select()
      .single();

    if (saleError) throw saleError;

    /* Fetch inventory FIFO */
    const { data: lots, error: lotError } = await supabase
      .from("inventory_lots")
      .select("*")
      .eq("user_id", user.id)
      .eq("item_id", item_id)
      .gt("quantity_remaining", 0)
      .order("created_at", { ascending: true });

    if (lotError) throw lotError;

    let remaining = quantity;

    /* Deplete inventory */
    for (const lot of lots ?? []) {
      if (remaining <= 0) break;

      const consume = Math.min(remaining, lot.quantity_remaining);

      await supabase
        .from("inventory_lots")
        .update({
          quantity_remaining: lot.quantity_remaining - consume,
        })
        .eq("id", lot.id);

      await supabase
        .from("inventory_movements")
        .insert({
          user_id: user.id,
          inventory_lot_id: lot.id,
          sale_id: sale.id,
          quantity: consume,
        });

      remaining -= consume;
    }

    /* Oversold handling */
    if (remaining > 0) {
      await supabase
        .from("sales")
        .update({ inventory_status: "oversold" })
        .eq("id", sale.id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        sale_id: sale.id,
        inventory_status: remaining > 0 ? "oversold" : "ok",
        unfulfilled_quantity: remaining,
      }),
      { status: 200 }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500 }
    );
  }
});
