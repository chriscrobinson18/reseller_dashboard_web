// record_return — records a (partial or full) refund against a sale.
//
// v2 (2026-08-27): accepts optional `refund_transaction_id` /
// `return_shipping_transaction_id` — when given, the CSV reconciliation layer
// is re-tagging existing `csv_import` transactions rows (a real bank/marketplace
// refund + return-shipping charge already imported) instead of asking this
// function to invent new ones. See docs/superpowers/specs/2026-08-27-csv-return-reconciliation-design.md.
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
//   5. Refund transaction row: `schedule_c_category = 'returns_allowances'`,
//      `related_sale_id = sale_id`. The dashboard's Schedule C breakdown shows
//      this as a negative Part I line (Returns & Allowances) that reduces
//      gross receipts. Manual path (no `refund_transaction_id`): inserts a
//      new row (`amount = -refund_amount`, `type: 'refund'`, `source:
//      'manual'`), which `reverse_return` finds by `related_sale_id` +
//      `type='refund'` and deletes. CSV path (`refund_transaction_id` given):
//      re-tags that existing `csv_import` row in place instead — its real
//      date/amount are trusted over "today" + the typed estimate, and it's
//      never deleted, only un-tagged, since it's real imported bank history.
//   6. Return-shipping row, same manual-insert-vs-CSV-re-tag split, keyed on
//      `return_shipping_cost` (manual) vs `return_shipping_transaction_id`
//      (CSV) — `schedule_c_category = 'shipping_postage'`. On the CSV path
//      the category doesn't change (it was already `shipping_postage` on
//      import); only `related_sale_id` is set.
//
// See docs/superpowers/specs/2026-06-23-p0-tax-correctness-design.md § C
// (P0 item 5) for the cost-basis and refund-row rationale.

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
    const {
      sale_id,
      quantity,
      refund_amount,
      reason,
      return_shipping_cost,
      source = "manual",
      refund_transaction_id,
      return_shipping_transaction_id,
    } = body;

    if (!sale_id || !quantity || quantity <= 0 || refund_amount == null) {
      return json(400, { error: "Invalid input" });
    }

    /* CSV reconciliation: validate + guard the transaction(s) being re-tagged
       before touching anything else, so a double-apply (same CSV row matched
       twice) fails cleanly instead of double-restoring inventory. */
    let refundTx: { id: string; date: string; amount: number } | null = null;
    let shippingTx: { id: string; date: string; amount: number } | null = null;

    if (refund_transaction_id) {
      const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .select("id, date, amount, related_sale_id")
        .eq("id", refund_transaction_id)
        .eq("user_id", user.id)
        .single();
      if (txErr || !tx) return json(404, { error: "Refund transaction not found" });
      if (tx.related_sale_id) {
        return json(409, { error: "This transaction is already linked to a sale" });
      }
      refundTx = tx;
    }

    if (return_shipping_transaction_id) {
      const { data: tx, error: txErr } = await supabase
        .from("transactions")
        .select("id, date, amount, related_sale_id")
        .eq("id", return_shipping_transaction_id)
        .eq("user_id", user.id)
        .single();
      if (txErr || !tx) return json(404, { error: "Return-shipping transaction not found" });
      if (tx.related_sale_id) {
        return json(409, { error: "This transaction is already linked to a sale" });
      }
      shippingTx = tx;
    }

    /* Fetch sale */
    const { data: sale, error: saleError } = await supabase
      .from("sales")
      .select("*")
      .eq("id", sale_id)
      .eq("user_id", user.id)
      .single();

    if (saleError || !sale) {
      return json(404, { error: "Sale not found" });
    }

    const refundedSoFar = sale.refunded_quantity ?? 0;
    const refundableQty = sale.quantity - refundedSoFar;

    if (quantity > refundableQty) {
      return json(400, { error: "Refund exceeds sold quantity" });
    }

    /* Insert return record */
    await supabase.from("returns").insert({
      user_id: user.id,
      sale_id,
      quantity,
      refund_amount,
      reason,
      source,
      refund_transaction_id: refundTx?.id ?? null,
      return_shipping_transaction_id: shippingTx?.id ?? null,
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

    /* Refund row (Schedule C: Returns & Allowances). CSV reconciliation
       re-tags the real imported transaction instead of inventing a new one —
       its date/amount are the actual bank/marketplace record, more accurate
       than "today" + the typed estimate. */
    const today = new Date().toISOString().slice(0, 10);
    if (refundTx) {
      await supabase
        .from("transactions")
        .update({
          related_sale_id: sale_id,
          schedule_c_category: "returns_allowances",
        })
        .eq("id", refundTx.id);
    } else {
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
    }

    /* Return-shipping-cost row, if any (Schedule C: Shipping & Postage — a
       deductible expense, distinct from the buyer refund above). Same
       re-tag-vs-insert split as the refund row. */
    const shippingCost = Number(return_shipping_cost) || 0;
    if (shippingTx) {
      // Category was already 'shipping_postage' when imported — only the
      // sale link is new.
      await supabase
        .from("transactions")
        .update({ related_sale_id: sale_id })
        .eq("id", shippingTx.id);
    } else if (shippingCost > 0) {
      await supabase.from("transactions").insert({
        user_id: user.id,
        date: today,
        amount: -shippingCost,
        merchant: sale.platform
          ? `${sale.platform} return shipping`
          : "Return shipping",
        type: "refund",
        source: "manual",
        schedule_c_category: "shipping_postage",
        related_sale_id: sale_id,
      });
    }

    return json(200, {
      success: true,
      sale_id,
      refunded_quantity: newRefundedQty,
      refunded_amount: newRefundedAmt,
      units_restored: quantity - toRestore,
    });
  } catch (err) {
    return json(500, { error: String(err) });
  }
});
