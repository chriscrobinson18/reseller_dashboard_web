-- sales.payment_method: how the money actually arrived.
--
-- Distinct from `platform`, which records *where* the sale happened. The two are
-- orthogonal — an eBay sale and a face-to-face sale can both settle over PayPal,
-- and an in-person sale has no meaningful marketplace at all. Folding payment
-- rails into `platform` would have destroyed per-marketplace reporting.
--
-- Practical driver: in-person sales settle over Venmo / Cash App / Zelle / cash,
-- and only some of those ever appear in a bank feed. Recording the rail is what
-- lets you reconcile 1099-K totals (which cover goods-and-services rails) against
-- sales the app knows about, and explains why a cash sale has no matching deposit.
--
-- Nullable and unconstrained on purpose: historical sales predate the column, and
-- payment rails change faster than migrations. The UI offers a known list.

alter table public.sales add column if not exists payment_method text;

create index if not exists sales_payment_method_idx
  on public.sales(payment_method)
  where payment_method is not null;

comment on column public.sales.payment_method is
  'How the buyer paid: cash, venmo, cashapp, paypal, apple_pay, zelle, card, other. Orthogonal to platform (where the sale happened). Null for sales recorded before this column existed.';
