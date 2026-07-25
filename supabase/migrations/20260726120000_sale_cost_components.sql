-- add_sale_cost_components(p_sale_id, p_components): attach extra COGS to a sale.
--
-- A sale's COGS is the sum of its inventory_movements, and that table has no
-- item constraint — movements for several DIFFERENT items can coexist on one
-- sale. This function is what writes them: for each {item_id, quantity} in
-- p_components it FIFO-depletes that item's lots and inserts the matching
-- movement rows against p_sale_id.
--
-- The use case: a VHS sold with a remote bought separately to raise its value.
-- One sale, one price, cost drawn from two items. `sales.item_id` remains the
-- primary item; components are identified by having a lot whose item_id
-- differs from it.
--
-- Why an RPC and not a change to the record_sale edge function: same reasoning
-- as reverse_sale — the real work belongs in one Postgres transaction with
-- SELECT … FOR UPDATE on the lot rows. record_sale's loop is a sequence of
-- separate HTTP-scoped statements and can interleave with a concurrent write.
--
-- Oversell is non-fatal, matching record_sale: if a component can't be fully
-- sourced the sale is flagged `oversold` and the shortfall is reported back,
-- rather than raising and losing the sale that was just recorded.
--
-- NOT idempotent — this is purely additive, so calling it twice with the same
-- arguments depletes twice. It is only ever called once, immediately after
-- record_sale, from recordSale()/recordBundleSale() in src/lib/mutations.ts.
--
-- Security: SECURITY DEFINER so it can write RLS-scoped tables, but the sale's
-- user_id is verified against auth.uid() and lots are filtered to that same
-- user, so a caller cannot consume someone else's inventory. Granted only to
-- `authenticated`.
--
-- Errors: sale_not_found / forbidden / already_deleted / invalid_components.

CREATE OR REPLACE FUNCTION public.add_sale_cost_components(
  p_sale_id uuid,
  p_components jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_deleted_at timestamptz;
  v_component jsonb;
  v_item_id uuid;
  v_qty int;
  v_remaining int;
  v_consume int;
  v_lot record;
  v_unfulfilled jsonb := '{}'::jsonb;
  v_any_short boolean := false;
  v_movements int := 0;
BEGIN
  -- Lock and verify the sale (same guards, same ERRCODEs as reverse_sale).
  SELECT user_id, deleted_at INTO v_user_id, v_deleted_at
  FROM public.sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sale_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_deleted' USING ERRCODE = '23505';
  END IF;

  IF p_components IS NULL OR jsonb_typeof(p_components) <> 'array' THEN
    RAISE EXCEPTION 'invalid_components' USING ERRCODE = '22023';
  END IF;

  FOR v_component IN SELECT * FROM jsonb_array_elements(p_components)
  LOOP
    v_item_id := (v_component ->> 'item_id')::uuid;
    v_qty     := (v_component ->> 'quantity')::int;

    IF v_item_id IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_components' USING ERRCODE = '22023';
    END IF;

    v_remaining := v_qty;

    -- FIFO: oldest lot first, matching record_sale's ordering exactly.
    -- FOR UPDATE serializes us against a concurrent sale touching these lots.
    FOR v_lot IN
      SELECT id, quantity_remaining
      FROM public.inventory_lots
      WHERE user_id = v_user_id
        AND item_id = v_item_id
        AND quantity_remaining > 0
      ORDER BY created_at ASC
      FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;

      v_consume := LEAST(v_remaining, v_lot.quantity_remaining);

      UPDATE public.inventory_lots
      SET quantity_remaining = quantity_remaining - v_consume
      WHERE id = v_lot.id;

      INSERT INTO public.inventory_movements (user_id, inventory_lot_id, sale_id, quantity)
      VALUES (v_user_id, v_lot.id, p_sale_id, v_consume);

      v_movements := v_movements + 1;
      v_remaining := v_remaining - v_consume;
    END LOOP;

    IF v_remaining > 0 THEN
      v_any_short  := true;
      v_unfulfilled := v_unfulfilled || jsonb_build_object(v_item_id::text, v_remaining);
    END IF;
  END LOOP;

  IF v_any_short THEN
    UPDATE public.sales SET inventory_status = 'oversold' WHERE id = p_sale_id;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'movements_created', v_movements,
    'unfulfilled', v_unfulfilled
  );
END;
$$;

REVOKE ALL ON FUNCTION public.add_sale_cost_components(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_sale_cost_components(uuid, jsonb) TO authenticated;
