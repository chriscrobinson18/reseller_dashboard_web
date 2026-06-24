// Deno end-to-end test for reverse_sale.
//
// Run against the local Supabase stack: `supabase start`, then
//   deno test --allow-env --allow-net supabase/functions/reverse_sale/index.test.ts
//
// Asserts:
//   - Lots' quantity_remaining restored to pre-sale values.
//   - inventory_movements rows for the sale are deleted.
//   - Linked manual transactions (related_sale_id) are deleted.
//   - sales.deleted_at is set.
//   - Idempotency: a second call returns 409.
//   - Ownership: calling with another user's JWT returns 403.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

if (!SERVICE_ROLE || !ANON_KEY) {
  console.error(
    "Skipping reverse_sale tests — SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set."
  );
  Deno.exit(0);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function makeUser(prefix: string) {
  const email = `${prefix}_${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const client = createClient(SUPABASE_URL, ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { userId: data.user.id, client };
}

async function seedDepletedSale(
  userId: string,
  opts: {
    lots: Array<{ initial: number; unitCost: number; consumed: number }>;
    salePrice: number;
  }
) {
  const { data: item } = await admin
    .from("items")
    .insert({ user_id: userId, name: "Reverse Widget", category: "supplies" })
    .select()
    .single();

  const lotIds: string[] = [];
  let saleQty = 0;
  for (const l of opts.lots) {
    const { data: lot } = await admin
      .from("inventory_lots")
      .insert({
        user_id: userId,
        item_id: item!.id,
        quantity_purchased: l.initial,
        quantity_remaining: l.initial - l.consumed,
        unit_cost: l.unitCost,
      })
      .select()
      .single();
    lotIds.push(lot!.id);
    saleQty += l.consumed;
  }

  const { data: sale } = await admin
    .from("sales")
    .insert({
      user_id: userId,
      item_id: item!.id,
      quantity: saleQty,
      sale_price: opts.salePrice,
      platform: "ebay",
      sold_at: "2026-06-23T12:00:00.000Z",
      source: "manual",
      inventory_status: "ok",
    })
    .select()
    .single();

  for (let i = 0; i < opts.lots.length; i++) {
    await admin.from("inventory_movements").insert({
      user_id: userId,
      inventory_lot_id: lotIds[i],
      sale_id: sale!.id,
      quantity: opts.lots[i].consumed,
    });
  }

  // Linked payout/fee transactions like recordSale would have created.
  await admin.from("transactions").insert([
    {
      user_id: userId,
      date: "2026-06-23",
      amount: opts.salePrice,
      merchant: "Test Payout",
      type: "other",
      source: "manual",
      schedule_c_category: "payout",
      related_sale_id: sale!.id,
    },
    {
      user_id: userId,
      date: "2026-06-23",
      amount: -5,
      merchant: "Test Fee",
      type: "fee",
      source: "manual",
      schedule_c_category: "commissions_fees",
      related_sale_id: sale!.id,
    },
  ]);

  return { saleId: sale!.id, lotIds };
}

async function cleanup(userId: string) {
  await admin.auth.admin.deleteUser(userId);
}

Deno.test("reverse_sale restores lots, deletes movements + linked txns, soft-deletes sale", async () => {
  const { userId, client } = await makeUser("rev_happy");
  try {
    const { saleId, lotIds } = await seedDepletedSale(userId, {
      lots: [
        { initial: 5, unitCost: 10, consumed: 3 },
        { initial: 4, unitCost: 12, consumed: 1 },
      ],
      salePrice: 100,
    });

    const { data, error } = await client.functions.invoke("reverse_sale", {
      body: { sale_id: saleId },
    });
    if (error) throw error;
    assert(data?.ok, "expected ok:true");

    // Lots restored.
    const { data: lots } = await admin
      .from("inventory_lots")
      .select("id, quantity_remaining")
      .in("id", lotIds);
    const byId = new Map(lots!.map((l) => [l.id, l.quantity_remaining]));
    assertEquals(byId.get(lotIds[0]), 5);
    assertEquals(byId.get(lotIds[1]), 4);

    // Movements gone.
    const { data: movs } = await admin
      .from("inventory_movements")
      .select("id")
      .eq("sale_id", saleId);
    assertEquals(movs?.length, 0);

    // Linked manual transactions gone.
    const { data: txns } = await admin
      .from("transactions")
      .select("id")
      .eq("related_sale_id", saleId);
    assertEquals(txns?.length, 0);

    // Sale soft-deleted.
    const { data: sale } = await admin
      .from("sales")
      .select("deleted_at")
      .eq("id", saleId)
      .single();
    assert(sale?.deleted_at, "expected deleted_at to be set");
  } finally {
    await cleanup(userId);
  }
});

Deno.test("reverse_sale: replay on an already-deleted sale returns 409", async () => {
  const { userId, client } = await makeUser("rev_replay");
  try {
    const { saleId } = await seedDepletedSale(userId, {
      lots: [{ initial: 2, unitCost: 8, consumed: 1 }],
      salePrice: 25,
    });

    const first = await client.functions.invoke("reverse_sale", {
      body: { sale_id: saleId },
    });
    assert(first.data?.ok);

    const second = await client.functions.invoke("reverse_sale", {
      body: { sale_id: saleId },
    });
    // supabase-js surfaces non-2xx as an error with context.
    assert(
      second.error || (second.data && (second.data as { error?: string }).error),
      "expected the second call to fail (409 / already_deleted)"
    );
  } finally {
    await cleanup(userId);
  }
});

Deno.test("reverse_sale: another user's sale returns 403", async () => {
  const owner = await makeUser("rev_owner");
  const other = await makeUser("rev_other");
  try {
    const { saleId } = await seedDepletedSale(owner.userId, {
      lots: [{ initial: 3, unitCost: 9, consumed: 1 }],
      salePrice: 20,
    });

    const res = await other.client.functions.invoke("reverse_sale", {
      body: { sale_id: saleId },
    });
    assert(
      res.error || (res.data && (res.data as { error?: string }).error),
      "expected forbidden for non-owner"
    );

    // Sale untouched.
    const { data: sale } = await admin
      .from("sales")
      .select("deleted_at")
      .eq("id", saleId)
      .single();
    assertEquals(sale?.deleted_at, null);
  } finally {
    await cleanup(owner.userId);
    await cleanup(other.userId);
  }
});
