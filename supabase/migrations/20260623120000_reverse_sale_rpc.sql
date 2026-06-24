-- reverse_sale(p_sale_id): atomically undo a sale.
--
--   1. Restores `quantity_remaining` on every lot the sale depleted
--      (driven by inventory_movements rows for the sale).
--   2. Deletes those inventory_movements rows.
--   3. Deletes any manual `transactions` rows linked via related_sale_id
--      (payout / fee / shipping rows created by recordSale).
--   4. Soft-deletes the sale (sets sales.deleted_at).
--
-- Atomicity: the whole function runs in a single transaction, so a crash at
-- any step rolls back the partial state — eliminating the lot-understated
-- "I fat-fingered a sale, let me delete and re-record" bug.
--
-- Concurrency: lot rows are SELECT … FOR UPDATE before any update,
-- serializing this RPC against a concurrent record_sale touching the same
-- lots.
--
-- Security: SECURITY DEFINER so the function can write to RLS-scoped tables
-- regardless of the caller's policies, but we explicitly verify the sale's
-- user_id matches auth.uid() and refuse otherwise. Granted to `authenticated`
-- so anon callers cannot invoke it.
--
-- Idempotency: a second call on an already soft-deleted sale raises
-- `already_deleted`, so retries don't double-restore stock.

CREATE OR REPLACE FUNCTION public.reverse_sale(p_sale_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_deleted_at timestamptz;
  v_lots_restored int := 0;
  v_txn_deleted int := 0;
BEGIN
  -- Lock and verify the sale.
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

  -- Lock the affected lot rows so a concurrent record_sale cannot
  -- read stale quantity_remaining between our restore and its update.
  PERFORM 1
  FROM public.inventory_lots
  WHERE id IN (
    SELECT inventory_lot_id
    FROM public.inventory_movements
    WHERE sale_id = p_sale_id
  )
  FOR UPDATE;

  -- Restore quantity_remaining on each source lot.
  WITH movs AS (
    SELECT inventory_lot_id, quantity
    FROM public.inventory_movements
    WHERE sale_id = p_sale_id
  )
  UPDATE public.inventory_lots l
  SET quantity_remaining = l.quantity_remaining + movs.quantity
  FROM movs
  WHERE l.id = movs.inventory_lot_id;
  GET DIAGNOSTICS v_lots_restored = ROW_COUNT;

  -- Wipe the audit rows for this sale.
  DELETE FROM public.inventory_movements WHERE sale_id = p_sale_id;

  -- Wipe linked manual transactions (payout/fee/shipping).
  DELETE FROM public.transactions
  WHERE related_sale_id = p_sale_id AND source = 'manual';
  GET DIAGNOSTICS v_txn_deleted = ROW_COUNT;

  -- Soft-delete the sale.
  UPDATE public.sales SET deleted_at = now() WHERE id = p_sale_id;

  RETURN json_build_object(
    'ok', true,
    'lots_restored', v_lots_restored,
    'transactions_deleted', v_txn_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_sale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_sale(uuid) TO authenticated;
