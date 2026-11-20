---
name: add-cogs-lots
description: Turn unlinked cost-of-goods charges into inventory lots by matching each charge to its order confirmation email in Gmail. Use when the owner asks to "add lots", "link COGS charges to inventory", "match charges to order emails", or runs /add-cogs-lots. Optional argument: a period such as "2026", "2026-10", "2026-10-01..2026-11-20" or "last 30 days" (default: year to date).
---

# Add inventory lots to cost-of-goods charges from order emails

Every `cost_of_goods` card or bank charge should fund inventory lots whose cost adds up **exactly** to the charge. This skill:

1. finds charges that don't fully fund lots yet;
2. finds each charge's order email in Gmail;
3. proposes the lots;
4. writes them **only after the owner approves**;
5. verifies the result twice.

**Read first:**
- `CLAUDE.md`
- `docs/features/inventory.md` → "Lot data rules"
- `docs/books-cleanup-handoff.md` → "Working rules" and the decision log
- `docs/operations.md` → "Data writes (production)"

If those docs disagree with this file, the docs win. Update this file in the same change.

## Ground rules (never skip)

- **The repo is public.** Never put amounts, merchants, order numbers, item names or personal names in commits, docs or code. Proposals and backups go in the session scratchpad, never in git.
- **Owner approval comes before any production write.** Propose in batches, with one line of reason per charge.
- **Every row you create or change** gets `review_status = 'ai_reviewed'` and `reviewed_at = now()`. Rows marked `owner_reviewed` are locked: list them for the owner and don't try to get around the lock.
- **Check every number a second way** before reporting it, e.g. sum per charge and sum overall; lot rows versus allocation rows.
- **Never link a pending charge** (`transactions.pending = true`). When it posts, Plaid can replace the row. The sync then hard-deletes the pending row, and the database deletes its lot links with it, leaving orphaned lots at full cost. Wait until the charge has posted.

## Tools and access

- **Production SQL:** the Supabase Management API, which the proxy authenticates. Send `Authorization: Bearer dummy`; the proxy swaps in the real credential. Use `POST https://api.supabase.com/v1/projects/<project-ref>/database/query/read-only` with the body `{"query": "..."}` for reads, and the same URL without `/read-only` for approved writes. The project ref is in `supabase/.temp/linked-project.json` (see `docs/operations.md`). Put SQL in a scratchpad file and send it as JSON with a small Python helper. Don't inline it in a shell heredoc: `$$`, `${}` and backticks get mangled.
- **Gmail:** the `mcp__Gmail__search_threads` and `mcp__Gmail__get_thread` tools; load them with ToolSearch if they're deferred. If no Gmail tools exist, **stop**: tell the owner the Gmail connector isn't connected to this session (call `read_documentation` with topic `connectors.add`), and offer to continue once it is.
- **Writes** run as one `begin; … commit;` with a `do $$ … $$` block that checks counts and raises an exception on any mismatch, so a failed check rolls everything back.

## Step 1: Find candidate charges (read-only)

Turn the argument into `:start` / `:end`. With no argument, use Jan 1 of this year through today.

```sql
select t.id, t.date, round(t.amount*100)::bigint as cents, t.merchant, t.account_display, t.pending,
       t.review_status, t.notes, t.user_id,
       coalesce((select sum(x.allocated_amount) from inventory_lot_transactions x
                 join inventory_lots l on l.id = x.lot_id and l.deleted_at is null
                 where x.transaction_id = t.id), 0) as allocated
from transactions t
where t.schedule_c_category = 'cost_of_goods' and t.amount < 0
  and t.net_zero_pair_id is null and t.trade_id is null
  and coalesce(t.source, '') <> 'csv_import'
  and t.date between :start and :end
  and coalesce((select sum(x.allocated_amount) from inventory_lot_transactions x
                join inventory_lots l on l.id = x.lot_id and l.deleted_at is null
                where x.transaction_id = t.id), 0) < -t.amount - 0.005
order by t.date;
```

- `allocated = 0` means **unlinked**. `0 < allocated < charge` means **partly linked**: only the remainder may be allocated, and only for items not already in lots.
- Set aside `pending = true` charges: report them as "wait until posted".
- Set aside `owner_reviewed` charges: report them, and don't write.
- Rows sharing date, amount and merchant are genuine repeat charges. Each one needs its own order.

## Step 2: Clear refunds and non-inventory first

For each candidate, before touching lots:

1. **Exact refund?** Look for an unpaired positive row with the exact opposite amount in cents, from the same merchant, within 90 days.
   - If found, propose a **net-zero pair**, not lots. In the app: Expenses → Net-zero pairs → Find matches in bulk, or the transaction's "Net-zero match" panel. In SQL: one shared `net_zero_pair_id`, set only where it is null; check that exactly 2 rows changed.
   - **Exception:** don't pair when the charge and refund fall in different tax years. The refund correctly reduces the later year's cost of goods.
   - **Exception:** if the owner says the goods were **refunded but kept**, pair the rows **and** create the lots at `unit_cost = 0` with `allocated_amount = 0`. Don't delete anything.
2. **Partial refund** (e.g. a restocking fee kept back): don't pair. Lots cover only the items actually kept; flag the charge for the owner.
3. **Not inventory** (memberships, subscriptions, store services, supplies): never a lot. Memberships go to the custom category "Memberships" (Line 27a). If one charge mixes goods and a membership, flag it for the owner, because transactions can't be split yet.

## Step 3: Find the order email

For each remaining charge, search Gmail. Card charges usually post 0–5 days after the order, and split shipments post per shipment.

- Start narrow: `from:<retailer domain or name> after:<date − 10 days> before:<date + 3 days>`, plus the exact total, e.g. `"123.45"`.
- Then widen: drop the amount, widen the window to −30/+7 days, and try "order", "receipt", "confirmation" or "shipped".
- Open the candidate thread and read the **order total**, the **line items** (name, quantity, unit price or line subtotal) and the **order date**.

**A match is valid only if** the merchant matches **and** the email's total, or a shipment's subtotal, equals the charge to the cent. Re-check every match against the other charges from that merchant, so no email is used twice and no charge gets two emails.

**Skip the charge** (leave it under Expenses → "Cost of goods without lots") and give the reason if:
- the email doesn't give each item's price or subtotal;
- several orders could plausibly match;
- the totals don't reconcile;
- it's a multi-order drop where this order was cancelled (cancelled orders become net-zero pairs instead).

A foreign-currency order still works: its prices give the ratio.

## Step 4: Build the lots (allocation math)

Work in **integer cents** throughout. `C` is the charge in cents (positive).

1. **Lines:** one line per distinct item, with `sub_i` = that line's subtotal from the email after item discounts, and `q_i` = units.
2. **Spread the charge by ratio,** so tax, shipping, fees and FX are shared proportionally:
   - `S = Σ sub_i`;
   - `raw_i = C × sub_i / S`, then `a_i = floor(raw_i)`;
   - hand out the leftover `C − Σ a_i` cents one each to the lines with the largest fractional parts (ties: larger `sub_i` first, then line order);
   - check that `Σ a_i = C` exactly.
3. **Penny-split each line,** as `splitLotCost` in `src/lib/lotCost.ts` does:
   - `base = floor(a_i / q_i)` and `extra = a_i − base × q_i`;
   - this gives one lot row of `q_i − extra` units at `base` cents, plus, if `extra > 0`, one lot row of `extra` units at `base + 1` cents;
   - each lot row's cost is units × unit cost, and per line they sum to `a_i`.
4. **Partly linked charge:** set `C` = charge − already allocated, and include only the items not yet in lots.
5. **Items:** reuse an existing item (`items`, `deleted_at is null`) when its name clearly refers to the same product: same set or model number, or near-identical wording. Otherwise create a new item with a clear product name. Don't create a duplicate of an existing item.
6. **Orphaned lots:** before creating a lot, check for an active lot of the same item with **no** `inventory_lot_transactions` row and a purchase date within a few days of the charge. That may be this purchase with its link lost. If so, propose re-linking it instead of creating a duplicate.

## Step 5: Propose to the owner (no writes yet)

Save the full plan as a scratchpad file, never in the repo. Show the owner a table per batch:

| Date | Merchant | Charge | Order email (subject, date) | Item | Qty | Allocated | Lot rows (qty × unit) | Status |

- **Status** is one of: ready; net-zero pair; refunded-but-kept; skip (with the reason); pending, so wait; owner-reviewed, so locked; not inventory.
- Show the total of the "ready" charges and the total of their allocations, computed separately. They must be equal.
- Ask for approval. The owner may approve all of it, some rows, or none.

## Step 6: Write (only what was approved)

Run one transaction. Templates (values come from the approved plan):

```sql
begin;
create temp table plan_lots (
  charge_id uuid, user_id uuid, item_id uuid, new_item_name text,
  qty int, unit_cents bigint, purchase_date date
) on commit drop;
insert into plan_lots values (...), (...);

do $do$ declare n int; bad int; begin
  -- guard: charges unchanged since the proposal (still unpaired, not owner-reviewed, not pending)
  select count(*) into bad from (select distinct charge_id from plan_lots) p join transactions t on t.id = p.charge_id
   where t.net_zero_pair_id is not null or t.review_status = 'owner_reviewed' or t.pending;
  if bad > 0 then raise exception 'charge changed since proposal: %', bad; end if;

  -- new items (guard against duplicates by name)
  insert into items (id, user_id, name)
  select gen_random_uuid(), p.user_id, p.new_item_name from (select distinct user_id, new_item_name from plan_lots where item_id is null) p
  where not exists (select 1 from items i where i.deleted_at is null and lower(i.name) = lower(p.new_item_name) and i.user_id = p.user_id);
  update plan_lots p set item_id = i.id from items i
   where p.item_id is null and i.deleted_at is null and lower(i.name) = lower(p.new_item_name) and i.user_id = p.user_id;
  if exists (select 1 from plan_lots where item_id is null) then raise exception 'unresolved item'; end if;

  -- lots + funding links
  with ins as (
    insert into inventory_lots (user_id, item_id, transaction_id, quantity_purchased, quantity_remaining,
                                unit_cost, initial_unit_cost, purchase_date, review_status, reviewed_at)
    select user_id, item_id, charge_id, qty, qty, unit_cents / 100.0, unit_cents / 100.0, purchase_date, 'ai_reviewed', now()
    from plan_lots
    returning id, transaction_id, user_id, quantity_purchased, unit_cost
  )
  insert into inventory_lot_transactions (user_id, lot_id, transaction_id, allocated_amount)
  select user_id, id, transaction_id, quantity_purchased * unit_cost from ins;

  -- every approved charge now fully funded, to the cent
  select count(*) into bad from (select distinct charge_id from plan_lots) p join transactions t on t.id = p.charge_id
   where round(-t.amount * 100) <> (select round(sum(x.allocated_amount) * 100) from inventory_lot_transactions x
                                     join inventory_lots l on l.id = x.lot_id and l.deleted_at is null
                                     where x.transaction_id = t.id);
  if bad > 0 then raise exception 'allocation mismatch on % charges', bad; end if;
end $do$;
commit;
```

- `purchase_date` is the **charge date**, the same convention as lots created from the Expenses panel.
- `inventory_lots.transaction_id` mirrors the primary (oldest) funding link. It is kept for the iOS app.
- All units stay on hand (`quantity_remaining = quantity_purchased`) until a sale is linked.
- For a partly linked charge, the final check must count the existing allocations too. The query above already does, because it sums every link on the charge.

## Step 7: Verify (twice) and report

1. Re-run the Step 1 query for the same period. Approved charges must be gone, and only skipped ones remain.
2. Recompute independently:
   - lots created = sum of approved lot rows, and units = sum of quantities;
   - `Σ allocated_amount` of the new links = `Σ |charge|` of approved charges, to the cent;
   - no lot has `quantity_remaining > quantity_purchased`.
3. Report in the owner's format: (1) direct answer, (2) reasoning, (3) alternatives and risks, (4) next steps. Include:
   - counts and totals per year;
   - the skipped list with reasons;
   - anything waiting on the owner (pending, locked, mixed charges, refunded-but-kept questions).

## Step 8 (optional, separate approval): link existing sales to the new lots

Only when the owner asks. Follow "Linking sales to lots" in `docs/features/inventory.md`:
- the sale clearly refers to the same product, and only one item plausibly matches;
- it's a sealed or whole product;
- the sale was **never fully refunded**;
- the quantities agree.

Link through `select link_sale_to_item(:sale_id, :item_id)`. It takes units from the oldest lots first, allowing a lot bought after the sale only within a 60-day presale window. Then set `review_status = 'ai_reviewed'` and `reviewed_at = now()` on each linked sale. Verify that no lot goes below 0, and that every movement is on the sale's own item.

## Step 9: Record it (counts only)

Add one line to `docs/books-cleanup-handoff.md` → "Production change history". Counts only: lots, charges, years. **No amounts, merchants or item names.** Commit on the session branch. Fast-forward `main` only when the owner says so.
