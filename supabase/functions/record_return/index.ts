// record_return — records a (partial or full) refund against a sale.
//
// Behavior:
//   1. Validates the return quantity against `sales.quantity - refunded_quantity`.
//   2. Inserts a `returns` row capturing reason/refund_amount/quantity.
//   3. Updates the sale's refunded_quantity/refunded_amount and return_status.
//   4. Reverses inventory_movements LIFO: restores quantity_remaining on each
//      source lot at the lot's original unit_cost (NOT sale_price). Movements
//      that are fully reversed are deleted; partial ones have their quantity
//      reduced. This keeps Schedule C Part III (COGS) consistent and avoids
//      the v20 bug that inserted a fake new lot priced at sale_price.
//   5. Inserts a `transactions` row for the refund:
//        amount = -refund_amount, schedule_c_category = 'returns_allowances',
//        related_sale_id = sale_id, source = 'manual'.
//      The dashboard's Schedule C breakdown shows this as a negative Part I
//      line (Returns & Allowances) that reduces gross receipts.
//
// See docs/superpowers/specs/2026-06-23-p0-tax-correctness-design.md § C
// (P0 item 5) for the cost-basis and refund-row rationale.

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
      sale_id,
      quantity,
      refund_amount,
      reason,
      source = "manual",
    } = body;

    if (!sale_id || !quantity || quantity <= 0 || refund_amount == null) {
      return new Response(
        JSON.stringify({ error: "Invalid input" }),
        { status: 400 }
      );
    }

    /* Fetch sale */
    const { data: sale, error: saleError } = await supabase
      .from("sales")
      .select("*")
      .eq("id", sale_id)
      .eq("user_id", user.id)
      .single();

    if (saleError || !sale) {
      return new Response(
        JSON.stringify({ error: "Sale not found" }),
        { status: 404 }
      );
    }

    const refundedSoFar = sale.refunded_quantity ?? 0;
    const refundableQty = sale.quantity - refundedSoFar;

    if (quantity > refundableQty) {
      return new Response(
        JSON.stringify({ error: "Refund exceeds sold quantity" }),
        { status: 400 }
      );
    }

    /* Insert return record */
    await supabase.from("returns").insert({
      user_id: user.id,
      sale_id,
      quantity,
      refund_amount,
      reason,
      source,
    });

    /* Update sale totals */
    const newRefundedQty = refundedSoFar + quantity;
    const newRefundedAmt = (sale.refunded_amount ?? 0) + refund_amount;

    await supabase
      .from("sales")
      .update({
        refunded_quantity: newRefundedQty,
        refunded_amount: newRefundedAmt,
        return_status:
          newRefundedQty === sale.quantity ? "full" : "partial",
        inventory_status: "reconciled",
      })
      .eq("id", sale_id);

    /* Reverse inventory_movements LIFO, restoring quantity_remaining on the
       original lots at the lots' original unit_cost (preserves cost basis). */
    const { data: movements, error: movErr } = await supabase
      .from("inventory_movements")
      .select("id, inventory_lot_id, quantity, created_at")
      .eq("sale_id", sale_id)
      .order("created_at", { ascending: false });
    if (movErr) throw movErr;

    let toRestore = quantity;
    for (const m of movements ?? []) {
      if (toRestore <= 0) break;
      const restoreQty = Math.min(toRestore, m.quantity);

      const { data: lotRow, error: lotReadErr } = await supabase
        .from("inventory_lots")
        .select("quantity_remaining")
        .eq("id", m.inventory_lot_id)
        .single();
      if (lotReadErr) throw lotReadErr;

      await supabase
        .from("inventory_lots")
        .update({
          quantity_remaining:
            (lotRow?.quantity_remaining ?? 0) + restoreQty,
        })
        .eq("id", m.inventory_lot_id);

      if (restoreQty === m.quantity) {
        await supabase
          .from("inventory_movements")
          .delete()
          .eq("id", m.id);
      } else {
        await supabase
          .from("inventory_movements")
          .update({ quantity: m.quantity - restoreQty })
          .eq("id", m.id);
      }

      toRestore -= restoreQty;
    }

    /* Insert refund transaction row (Schedule C: Returns & Allowances). */
    const today = new Date().toISOString().slice(0, 10);
    await supabase.from("transactions").insert({
      user_id: user.id,
      date: today,
      amount: -Number(refund_amount),
      merchant: sale.platform
        ? `${sale.platform} return`
        : "Sale return",
      type: "refund",
      source: "manual",
      schedule_c_category: "returns_allowances",
      related_sale_id: sale_id,
    });

    return new Response(
      JSON.stringify({
        success: true,
        sale_id,
        refunded_quantity: newRefundedQty,
        refunded_amount: newRefundedAmt,
        units_restored: quantity - toRestore,
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
