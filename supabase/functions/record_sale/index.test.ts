// Deno end-to-end test for record_sale.
//
// Run against the local Supabase stack: `supabase start`, then
//   deno test --allow-env --allow-net supabase/functions/record_sale/index.test.ts
//
// Env vars (defaulted to the local stack):
//   SUPABASE_URL                 default http://127.0.0.1:54321
//   SUPABASE_SERVICE_ROLE_KEY    required (printed by `supabase start`)
//   SUPABASE_ANON_KEY            required (printed by `supabase start`)
//
// Asserts:
//   - record_sale inserts a sale row and FIFO-depletes the lot.
//   - record_sale itself does NOT persist fees/shipping_cost (per contract).
//   - The client follow-up update path (which we simulate here) does persist
//     fees/shipping_cost/net_payout — guarding against a regression where
//     either side stops writing them.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

if (!SERVICE_ROLE || !ANON_KEY) {
  console.error(
    "Skipping record_sale tests — SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set."
  );
  Deno.exit(0);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function makeTestUser() {
  const email = `record_sale_${crypto.randomUUID()}@example.test`;
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

  return { userId: data.user.id, userClient, email };
}

async function seedItemAndLot(userId: string, quantity = 5, unitCost = 12) {
  const { data: item, error: itemErr } = await admin
    .from("items")
    .insert({ user_id: userId, name: "Test Widget", category: "supplies" })
    .select()
    .single();
  if (itemErr || !item) throw itemErr ?? new Error("item insert failed");

  const { data: lot, error: lotErr } = await admin
    .from("inventory_lots")
    .insert({
      user_id: userId,
      item_id: item.id,
      quantity_purchased: quantity,
      quantity_remaining: quantity,
      unit_cost: unitCost,
    })
    .select()
    .single();
  if (lotErr || !lot) throw lotErr ?? new Error("lot insert failed");

  return { itemId: item.id as string, lotId: lot.id as string };
}

async function cleanup(userId: string) {
  await admin.auth.admin.deleteUser(userId);
}

Deno.test("record_sale inserts sale + depletes lot; client follow-up persists fees/shipping", async () => {
  const { userId, userClient } = await makeTestUser();
  try {
    const { itemId, lotId } = await seedItemAndLot(userId, 5, 12);

    const fees = 7.5;
    const shippingCost = 3.25;
    const salePrice = 100;

    const { data, error } = await userClient.functions.invoke("record_sale", {
      body: {
        item_id: itemId,
        quantity: 2,
        sale_price: String(salePrice),
        platform: "ebay",
        sold_at: "2026-06-23T12:00:00.000Z",
        source: "manual",
      },
    });
    if (error) throw error;
    assert(data?.sale_id, "expected sale_id in response");
    assertEquals(data.inventory_status, "ok");

    // Lot depleted from 5 → 3.
    const { data: lot } = await admin
      .from("inventory_lots")
      .select("quantity_remaining")
      .eq("id", lotId)
      .single();
    assertEquals(lot?.quantity_remaining, 3);

    // record_sale itself did NOT write fees/shipping_cost.
    const { data: rawSale } = await admin
      .from("sales")
      .select("fees, shipping_cost, net_payout")
      .eq("id", data.sale_id)
      .single();
    assertEquals(rawSale?.fees ?? 0, 0);
    assertEquals(rawSale?.shipping_cost ?? null, null);

    // Simulate the client follow-up update (recordSale in mutations.ts).
    const netPayout = salePrice - fees - shippingCost;
    await userClient
      .from("sales")
      .update({
        fees,
        shipping_cost: shippingCost,
        net_payout: netPayout,
      })
      .eq("id", data.sale_id);

    const { data: finalSale } = await admin
      .from("sales")
      .select("fees, shipping_cost, net_payout")
      .eq("id", data.sale_id)
      .single();
    assertEquals(finalSale?.fees, fees);
    assertEquals(finalSale?.shipping_cost, shippingCost);
    assertEquals(finalSale?.net_payout, netPayout);
  } finally {
    await cleanup(userId);
  }
});
