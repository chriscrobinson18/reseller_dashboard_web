// reverse_return — undoes a single `returns` row so the client can implement
// "edit a return" as delete-then-re-record (same pattern as this codebase's
// trade-edit workaround; see TASKS.md "updateTrade mutation").
//
// Behavior:
//   1. Fetches the `returns` row and the parent `sales` row, verifying both
//      belong to the caller.
//   2. Re-depletes inventory FIFO for `returns.quantity` units of the sale's
//      item — same lot-selection algorithm as `record_sale` (oldest lot
//      first, ordered by created_at), so the reversal lands on whichever
//      lots currently have stock rather than assuming the original lots
//      still exist. Existing `inventory_movements` rows for (sale, lot) are
//      incremented instead of duplicated; otherwise a new row is inserted.
//   3. Decrements `sales.refunded_quantity` / `refunded_amount` by the
//      return's amounts (floored at 0) and recomputes `return_status`
//      ('none' / 'partial' / 'full'). `inventory_status` is reset to 'ok'
//      if re-depletion fully succeeded, else 'oversold'.
//   4. Deletes the refund + return-shipping `transactions` rows the original
//      `record_return` call inserted (both use `type: 'refund'`, scoped by
//      `related_sale_id`) — this assumes a sale has at most one active
//      return at a time (current UI scope; multiple concurrent returns per
//      sale are not supported).
//   5. Deletes the `returns` row itself.
//
// Not atomic (matches `record_return`'s own non-atomicity — sequential
// service-role calls, no Postgres transaction). A crash mid-flight can leave
// partial state; acceptable for now since this is only invoked by the
// client's edit-return flow immediately before a fresh `record_return` call.

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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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
      return json(401, { error: "Unauthorized" });
    }

    const body = await req.json();
    const { return_id } = body;

    if (!return_id) {
      return json(400, { error: "Invalid input" });
    }

    /* Fetch the return row */
    const { data: ret, error: retError } = await supabase
      .from("returns")
      .select("*")
      .eq("id", return_id)
      .eq("user_id", user.id)
      .single();

    if (retError || !ret) {
      return json(404, { error: "Return not found" });
    }

    /* Fetch the parent sale */
    const { data: sale, error: saleError } = await supabase
      .from("sales")
      .select("*")
      .eq("id", ret.sale_id)
      .eq("user_id", user.id)
      .single();

    if (saleError || !sale) {
      return json(404, { error: "Sale not found" });
    }

    /* Re-deplete inventory FIFO (same algorithm as record_sale). */
    let remaining = ret.quantity;

    if (sale.item_id) {
      const { data: lots, error: lotError } = await supabase
        .from("inventory_lots")
        .select("id, quantity_remaining")
        .eq("user_id", user.id)
        .eq("item_id", sale.item_id)
        .gt("quantity_remaining", 0)
        .order("created_at", { ascending: true });
      if (lotError) throw lotError;

      for (const lot of lots ?? []) {
        if (remaining <= 0) break;
        const consume = Math.min(remaining, lot.quantity_remaining);

        await supabase
          .from("inventory_lots")
          .update({ quantity_remaining: lot.quantity_remaining - consume })
          .eq("id", lot.id);

        const { data: existingMovement } = await supabase
          .from("inventory_movements")
          .select("id, quantity")
          .eq("sale_id", sale.id)
          .eq("inventory_lot_id", lot.id)
          .maybeSingle();

        if (existingMovement) {
          await supabase
            .from("inventory_movements")
            .update({ quantity: existingMovement.quantity + consume })
            .eq("id", existingMovement.id);
        } else {
          await supabase.from("inventory_movements").insert({
            user_id: user.id,
            inventory_lot_id: lot.id,
            sale_id: sale.id,
            quantity: consume,
          });
        }

        remaining -= consume;
      }
    }

    /* Update the sale's return totals. */
    const newRefundedQty = Math.max(0, (sale.refunded_quantity ?? 0) - ret.quantity);
    const newRefundedAmt = Math.max(0, (sale.refunded_amount ?? 0) - ret.refund_amount);

    await supabase
      .from("sales")
      .update({
        refunded_quantity: newRefundedQty,
        refunded_amount: newRefundedAmt,
        return_status:
          newRefundedQty === 0
            ? "none"
            : newRefundedQty === sale.quantity
            ? "full"
            : "partial",
        inventory_status: remaining > 0 ? "oversold" : "ok",
      })
      .eq("id", sale.id);

    /* Delete the refund + return-shipping transaction rows this return created. */
    await supabase
      .from("transactions")
      .delete()
      .eq("related_sale_id", sale.id)
      .eq("type", "refund");

    /* Delete the return record itself. */
    await supabase.from("returns").delete().eq("id", return_id);

    return json(200, {
      success: true,
      sale_id: sale.id,
      units_redepleted: ret.quantity - remaining,
    });
  } catch (err) {
    return json(500, { error: String(err) });
  }
});
