# eBay Order Earnings Import — Design

_2026-09-28 · P1 feature · web-first_

---

## Overview

eBay offers two CSV exports. Neither alone gives a complete picture:

- **Transaction Report**: has `Payout ID` for settlement matching and non-order event types (Refund, Shipping label, Charge, Adjustment), but bulk shipping labels appear as one unattributable row — per-order shipping cost is impossible.
- **Order Earnings Report**: has per-order `Shipping labels`, `Promoted Listing Standard fee`, `Discount`, `Payment Dispute Fee`, `Refunds`, and pre-calculated `Order earnings` — but no `Payout ID`, so no settlement matching.

This feature adds Order Earnings import as the **primary source for `sales` rows**, while Transaction Report remains the source for `transactions` rows (settlement matching, non-order events). `sync_csv_orders_to_sales` is disabled for eBay — it only creates sales for Amazon/Mercari.

---

## Data Model

### `sales` table — two new columns

```sql
alter table public.sales
  add column fee_breakdown jsonb default null,
  add column discount numeric default null;
```

- `fee_breakdown`: itemized fees from Order Earnings. Schema:

```json
{
  "final_value_fee_fixed": -0.40,
  "final_value_fee_variable": -5.36,
  "promoted_listing_standard": -1.21,
  "regulatory_operating": 0,
  "international": 0,
  "below_standard_performance": 0,
  "item_not_as_described": 0,
  "deposit_processing": 0,
  "payment_dispute": 0,
  "charity_donation": 0
}
```

- `discount`: numeric, the eBay discount applied to the order (from `Discount` column). Null when no discount.

Existing columns used as-is:
- `sale_price` ← `Gross amount` (total buyer payment: item subtotal + buyer-paid shipping)
- `fees` ← sum of all fee columns (existing column, for quick math)
- `shipping_cost` ← `Shipping labels` (seller's label cost)
- `net_payout` ← `Order earnings`
- `refunded_amount` ← abs of `Refunds` when non-zero
- `external_order_id` ← `Order number` (dedup key)
- `item_name` ← `Item title` (single-item order) or first title / `"N items"` (multi-item)
- `quantity` ← sum of `Quantity`
- `sold_at` ← `Order creation date`
- `platform` ← `'ebay'`
- `source` ← `'csv_import'`

No changes to `transactions` table.

### Multi-item order aggregation

When multiple rows share the same `Order number`:
- `sale_price` = sum of per-row `Gross amount` (or re-derive from `Item subtotal` + `Shipping and handling`)
- `quantity` = sum of `Quantity`
- `fees` = sum of all fee columns across rows
- `fee_breakdown` = sum each fee key across rows
- `shipping_cost` = sum of `Shipping labels`
- `discount` = sum of `Discount`
- `net_payout` = sum of `Order earnings`
- `refunded_amount` = sum of abs(`Refunds`)
- `item_name` = if 1 item, use `Item title`; if N > 1, first title or `"N items"`

One `sales` row per order. User links inventory items manually.

---

## Order Earnings CSV Format

### Preamble

The file starts with metadata rows before the header:
```
--,--,--,--,...
Notes
Report is based upon the order creation date...
...
Order earnings report
Seller,supremedistributionllc
Start date,Jan-01-2025 00:00:00 AM PST
End date,Jan-02-2026 23:59:59 PM PST
Report creation date,Sep-28-2026 16:31:55 PM PDT
```

### Header row

```
Order creation date,Order number,Item ID,Item title,Buyer name,Ship to city,
Ship to province/region/state,Ship to zip,Ship to country,Transaction currency,
eBay collected tax,Item price,Quantity,Item subtotal,Shipping and handling,
Seller collected tax,Discount,Payout currency,Gross amount,
Final Value Fee - fixed,Final Value Fee - variable,Below standard performance fee,
Very high "item not as described" fee,International fee,Deposit processing fee,
Regulatory operating fee,Promoted Listing Standard fee,Charity donation,
Shipping labels,Payment Dispute Fee,Expenses,Refunds,Order earnings
```

### Format detection

Detect by scanning for a row containing both `order creation date` AND `order earnings` (case-insensitive, trimmed). This distinguishes it from the Transaction Report (which has `transaction creation date`) and from Amazon formats.

### `--` handling

eBay uses `--` for null values. Treat `--` and empty string as null/zero for numeric columns.

---

## Parsing Logic

### In `import_marketplace_csv`

Add an `ebay_order_earnings` branch alongside the existing `ebay` (Transaction Report) branch. The `platform` parameter from the client determines which parser runs. Options:

- `platform = 'ebay'` → existing Transaction Report parser (unchanged)
- `platform = 'ebay_order_earnings'` → new Order Earnings parser

### Order Earnings parser

1. Skip preamble: scan rows until the header row is found (contains `order creation date` + `order earnings`)
2. Parse data rows below the header
3. Group by `Order number`
4. For each group, build one `sales` upsert row:
   - Parse all numeric columns (handle `--` as 0, strip `$` and commas)
   - Aggregate multi-item orders (sum numerics, pick first `Item title`)
   - Build `fee_breakdown` JSONB from individual fee columns
   - `sale_price` = `Gross amount`
   - `fees` = sum of: `Final Value Fee - fixed` + `Final Value Fee - variable` + `Promoted Listing Standard fee` + `Regulatory operating fee` + `International fee` + `Below standard performance fee` + `"item not as described" fee` + `Deposit processing fee` + `Payment Dispute Fee` + `Charity donation` (all as absolute values)
   - `shipping_cost` = abs(`Shipping labels`)
   - `discount` = abs(`Discount`) when non-zero
   - `net_payout` = `Order earnings`
   - `refunded_amount` = abs(`Refunds`) when non-zero
5. Upsert to `sales` on `(user_id, external_order_id)`

### Return value

Same shape as existing parsers: `{ rowsParsed, rowsSkipped, skippedTypes }`.

---

## Dedup on Overlapping Time Ranges

- Dedup key: `external_order_id = Order number` (e.g., `14-12531-38813`)
- Upsert: `INSERT ... ON CONFLICT (user_id, external_order_id) DO UPDATE SET ...`
- Reimporting the same order overwrites with identical data (idempotent)
- Reimporting after a refund: `Refunds` column reflects the updated value, `Order earnings` recalculated — upsert captures the change
- No prefix needed (unlike `ebay_oe_` discussed earlier) — the raw order number is unique within a user's eBay data

### Unique constraint

If `(user_id, external_order_id)` unique index doesn't already exist on `sales`, add it in the migration. Check existing constraints first — `sync_csv_orders_to_sales` may already rely on one.

---

## Transaction Report Changes

### `sync_csv_orders_to_sales` — skip eBay

Add a platform guard: when the imported transactions have `platform = 'ebay'`, do not create `sales` rows. Order Earnings is the sales source for eBay.

Amazon and Mercari continue using `sync_csv_orders_to_sales` as before.

### Transaction Report parser

No changes. Continues to create `transactions` rows with Payout ID for settlement matching.

---

## Sales Detail Page — Fee Breakdown

When `fee_breakdown` is present on a sale, the profitability section shows itemized fees instead of a single "Fees" line:

```
Revenue                    $37.90
  Gross amount

Fees                      -$6.97
  Final Value (fixed)      -$0.40
  Final Value (variable)   -$5.36
  Promoted Listing         -$1.21

Shipping                   -$4.63
  Shipping label

Discount                    $0.00

Order Earnings             $26.30
```

Only non-zero fee lines are shown. When `fee_breakdown` is null (manual sales, Amazon sales), falls back to showing the single `fees` total as today.

---

## UI — Settings Upload

Settings > Marketplace CSV > eBay section gets two upload cards:

1. **Transaction Report** (existing, unchanged) — label: "Transaction Report"
2. **Order Earnings** (new) — label: "Order Earnings"

Both upload independently. Each calls `import_marketplace_csv` with `platform = 'ebay'` or `platform = 'ebay_order_earnings'` respectively.

Hint text on Order Earnings card: "Seller Hub > Reports > Order Earnings Report. Adds per-order shipping costs and fee breakdown to your sales."

---

## What Doesn't Change

- Transaction Report parser (unchanged)
- Settlement Status view (reads from `transactions.payout_id`)
- Return reconciliation (reads Transaction Report Refund rows)
- Amazon / Mercari import flows
- `sync_csv_orders_to_sales` for Amazon/Mercari (unchanged)
- COGS / Schedule C calculations (read from `transactions`)
- Existing manual sale entry (RecordSaleModal)

---

## Known Limitations (v1)

- **No cross-link between Transaction Report and Order Earnings**: they share `Order number` but no active join is performed. Settlement groups stay on transactions; profitability stays on sales. A future enhancement could surface "which payout included this sale" on the sales detail page.
- **Multi-item order item names**: aggregated orders show first title or "N items". Individual item detail requires the user to inspect the order on eBay or link inventory items manually.
- **`Refunds` is informational only**: updating `refunded_amount` from Order Earnings does not trigger inventory restoration. Full return processing still uses Transaction Report Refund rows + the return reconciliation flow.
- **Buyer-paid shipping in `sale_price`**: `sale_price = Gross amount` includes buyer-paid shipping. This differs from manually recorded sales where `sale_price` is typically item-only. Margin calculations will reflect this difference. A future `buyer_shipping` column could separate them if needed.
