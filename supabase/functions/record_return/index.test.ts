// Deno end-to-end test for record_return.
//
// Run against the local Supabase stack: `supabase start`, then
//   deno test --allow-env --allow-net supabase/functions/record_return/index.test.ts
//
// Env vars (defaulted to the local stack):
//   SUPABASE_URL                 default http://127.0.0.1:54321
//   SUPABASE_SERVICE_ROLE_KEY    required (printed by `supabase start`)
//   SUPABASE_ANON_KEY            required (printed by `supabase start`)
//
// Asserts the two P0 fixes:
//   - Cost basis: returned units land back on the ORIGINAL lot at the lot's
//     original unit_cost. The v20 bug (insert a new lot priced at sale_price)
//     must not be present.
//   - Refund transaction row exists with amount = -refund_amount,
//     schedule_c_category = 'returns_allowances', related_sale_id = sale_id.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

if (!SERVICE_ROLE || !ANON_KEY) {
  console.error(
    "Skipping record_return tests — SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set."
  );
  Deno.exit(0);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function makeTestUser() {
  const email = `record_return_${crypto.randomUUID()}@example.test`;
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
    .insert({ user_id: userId, name: "Return Widget", category: "supplies" })
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

Deno.test("record_return restores original lot at lot.unit_cost and inserts a returns_allowances transaction", async () => {
  const { userId, userClient } = await makeTestUser();
  try {
    // Lot of 5 @ $12. Sold 2 @ $100 each (sale_price total = 200).
    // If the v20 bug were present, returning 1 would create a NEW lot priced
    // at sale_price/quantity = 100, NOT 12.
    const { lotId, saleId } = await seedSaleWithMovement(userId, {
      lotQty: 5,
      unitCost: 12,
      saleQty: 2,
      salePrice: 200,
    });

    const refundAmount = 100;
    const { data, error } = await userClient.functions.invoke("record_return", {
      body: {
        sale_id: saleId,
        quantity: 1,
        refund_amount: refundAmount,
        reason: "buyer remorse",
      },
    });
    if (error) throw error;
    assert(data?.success, "expected success");
    assertEquals(data.refunded_quantity, 1);

    // Original lot quantity_remaining restored: 3 (was 5 − 2 = 3) + 1 = 4.
    const { data: lotAfter } = await admin
      .from("inventory_lots")
      .select("quantity_remaining, unit_cost")
      .eq("id", lotId)
      .single();
    assertEquals(lotAfter?.quantity_remaining, 4);
    assertEquals(lotAfter?.unit_cost, 12);

    // No bogus second lot at sale_price.
    const { data: allLots } = await admin
      .from("inventory_lots")
      .select("id, unit_cost")
      .eq("user_id", userId);
    assertEquals(allLots?.length, 1, "should not create a new lot on return");
    assert(
      !allLots?.some((l) => Number(l.unit_cost) === 100),
      "must not insert a lot priced at sale_price"
    );

    // Movement reduced to 1 (was 2, restored 1).
    const { data: movs } = await admin
      .from("inventory_movements")
      .select("quantity")
      .eq("sale_id", saleId);
    assertEquals(movs?.length, 1);
    assertEquals(movs?.[0].quantity, 1);

    // Refund transaction row exists.
    const { data: txns } = await admin
      .from("transactions")
      .select("amount, schedule_c_category, related_sale_id, source")
      .eq("related_sale_id", saleId)
      .eq("schedule_c_category", "returns_allowances");
    assertEquals(txns?.length, 1);
    assertEquals(txns?.[0].amount, -refundAmount);
    assertEquals(txns?.[0].source, "manual");
  } finally {
    await cleanup(userId);
  }
});

Deno.test("record_return: full return restores all units and marks sale return_status=full", async () => {
  const { userId, userClient } = await makeTestUser();
  try {
    const { lotId, saleId } = await seedSaleWithMovement(userId, {
      lotQty: 3,
      unitCost: 8,
      saleQty: 2,
      salePrice: 50,
    });

    const { data, error } = await userClient.functions.invoke("record_return", {
      body: {
        sale_id: saleId,
        quantity: 2,
        refund_amount: 50,
        reason: "defective",
      },
    });
    if (error) throw error;
    assertEquals(data?.refunded_quantity, 2);

    const { data: lot } = await admin
      .from("inventory_lots")
      .select("quantity_remaining")
      .eq("id", lotId)
      .single();
    assertEquals(lot?.quantity_remaining, 3); // back to full

    const { data: movs } = await admin
      .from("inventory_movements")
      .select("id")
      .eq("sale_id", saleId);
    assertEquals(movs?.length, 0); // all reversed

    const { data: sale } = await admin
      .from("sales")
      .select("return_status, refunded_quantity")
      .eq("id", saleId)
      .single();
    assertEquals(sale?.return_status, "full");
    assertEquals(sale?.refunded_quantity, 2);
  } finally {
    await cleanup(userId);
  }
});
