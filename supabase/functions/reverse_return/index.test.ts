// Deno end-to-end test for reverse_return.
//
// Run against the local Supabase stack: `supabase start`, then
//   deno test --allow-env --allow-net supabase/functions/reverse_return/index.test.ts
//
// Env vars (defaulted to the local stack):
//   SUPABASE_URL                 default http://127.0.0.1:54321
//   SUPABASE_SERVICE_ROLE_KEY    required (printed by `supabase start`)
//   SUPABASE_ANON_KEY            required (printed by `supabase start`)
//
// Asserts the edit-a-return round trip (record_return, then reverse_return):
//   - Lot quantity_remaining and inventory_movements are restored to their
//     pre-return (i.e. post-sale) state.
//   - sales.refunded_quantity/refunded_amount/return_status/inventory_status
//     are reset.
//   - The refund + return-shipping transaction rows are deleted.
//   - The `returns` row itself is deleted.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

if (!SERVICE_ROLE || !ANON_KEY) {
  console.error(
    "Skipping reverse_return tests — SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set."
  );
  Deno.exit(0);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function makeTestUser() {
  const email = `reverse_return_${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");

  const userClient = createClient(SUPABASE_URL, ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await userClient.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;

  return { userId: data.user.id, userClient };
}

async function seedSaleWithMovement(
  userId: string,
  opts: { lotQty: number; unitCost: number; saleQty: number; salePrice: number }
) {
  const { data: item, error: itemErr } = await admin
    .from("items")
    .insert({ user_id: userId, name: "Reverse Return Widget", category: "supplies" })
    .select()
    .single();
  if (itemErr || !item) throw itemErr ?? new Error("item insert failed");

  const { data: lot, error: lotErr } = await admin
    .from("inventory_lots")
    .insert({
      user_id: userId,
      item_id: item.id,
      quantity_purchased: opts.lotQty,
      quantity_remaining: opts.lotQty - opts.saleQty,
      unit_cost: opts.unitCost,
    })
    .select()
    .single();
  if (lotErr || !lot) throw lotErr ?? new Error("lot insert failed");

  const { data: sale, error: saleErr } = await admin
    .from("sales")
    .insert({
      user_id: userId,
      item_id: item.id,
      quantity: opts.saleQty,
      sale_price: opts.salePrice,
      platform: "ebay",
      sold_at: "2026-06-23T12:00:00.000Z",
      source: "manual",
      inventory_status: "ok",
    })
    .select()
    .single();
  if (saleErr || !sale) throw saleErr ?? new Error("sale insert failed");

  const { error: movErr } = await admin.from("inventory_movements").insert({
    user_id: userId,
    inventory_lot_id: lot.id,
    sale_id: sale.id,
    quantity: opts.saleQty,
  });
  if (movErr) throw movErr;

  return { itemId: item.id, lotId: lot.id, saleId: sale.id };
}

async function cleanup(userId: string) {
  await admin.auth.admin.deleteUser(userId);
}

Deno.test("reverse_return undoes a partial return: lot, movement, sale totals, and transactions all restored", async () => {
  const { userId, userClient } = await makeTestUser();
  try {
    // Lot of 5 @ $12. Sold 2 @ $100 each.
    const { lotId, saleId } = await seedSaleWithMovement(userId, {
      lotQty: 5,
      unitCost: 12,
      saleQty: 2,
      salePrice: 200,
    });

    const { data: returnData, error: returnErr } = await userClient.functions.invoke(
      "record_return",
      {
        body: {
          sale_id: saleId,
          quantity: 1,
          refund_amount: 100,
          return_shipping_cost: 8,
          reason: "buyer remorse",
        },
      }
    );
    if (returnErr) throw returnErr;
    assert(returnData?.success, "expected record_return success");

    const { data: returnRow } = await admin
      .from("returns")
      .select("id")
      .eq("sale_id", saleId)
      .single();
    assert(returnRow?.id, "expected a returns row to exist");

    const { data: reverseData, error: reverseErr } = await userClient.functions.invoke(
      "reverse_return",
      { body: { return_id: returnRow!.id } }
    );
    if (reverseErr) throw reverseErr;
    assert(reverseData?.success, "expected reverse_return success");

    // Lot back to post-sale state (5 - 2 = 3).
    const { data: lotAfter } = await admin
      .from("inventory_lots")
      .select("quantity_remaining")
      .eq("id", lotId)
      .single();
    assertEquals(lotAfter?.quantity_remaining, 3);

    // Movement back to original sale quantity (2).
    const { data: movs } = await admin
      .from("inventory_movements")
      .select("quantity")
      .eq("sale_id", saleId);
    assertEquals(movs?.length, 1);
    assertEquals(movs?.[0].quantity, 2);

    // Sale return fields reset.
    const { data: sale } = await admin
      .from("sales")
      .select("return_status, refunded_quantity, refunded_amount, inventory_status")
      .eq("id", saleId)
      .single();
    assertEquals(sale?.return_status, "none");
    assertEquals(sale?.refunded_quantity, 0);
    assertEquals(Number(sale?.refunded_amount), 0);
    assertEquals(sale?.inventory_status, "ok");

    // Refund + return-shipping transactions deleted.
    const { data: txns } = await admin
      .from("transactions")
      .select("id")
      .eq("related_sale_id", saleId)
      .eq("type", "refund");
    assertEquals(txns?.length, 0);

    // Returns row deleted.
    const { data: returnsAfter } = await admin
      .from("returns")
      .select("id")
      .eq("sale_id", saleId);
    assertEquals(returnsAfter?.length, 0);
  } finally {
    await cleanup(userId);
  }
});
