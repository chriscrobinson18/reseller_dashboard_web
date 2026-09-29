# TCGPlayer Import — Design Spec (2026-09-28)

## Overview

Import TCGPlayer sales into the reseller dashboard with exact fee data using a
Tampermonkey userscript that calls TCGPlayer's internal seller-portal API, then
uploads the result to a new Supabase edge function.

**Approach:** Tampermonkey script → JSON download → upload to app (Option B).
Direct-to-`sales` model (same as eBay Order Earnings — no `transactions` intermediate).

---

## Data Sources

### TCGPlayer Internal API (seller portal, session-authenticated)

**List all orders (paginated):**
```
POST https://order-management-api.tcgplayer.com/orders/search?api-version=2.0
{
  "searchRange": "LastThreeMonths",
  "filters": { "sellerKey": "<sellerKey>" },
  "sortBy": [{ "sortingType": "orderDate", "direction": "ascending" }],
  "from": 0,
  "size": 100
}
```
Response: `{ totalOrders, orders[] }` — each order has `orderNumber`, `orderDate`,
`orderStatus`, `productAmount`, `shippingAmount`, `totalAmount`, `buyerPaid`.
No fee data at this level.

**Order detail (fees + refunds):**
```
GET https://order-management-api.tcgplayer.com/orders/{orderNumber}?api-version=2.0
```
Response adds: `transaction.feeAmount`, `transaction.netAmount`,
`transaction.directFeeAmount`, `transaction.taxes[]`, `products[]`, `refunds[]`,
`refundStatus`.

### sellerKey
The `sellerKey` is the lowercase prefix of all order numbers (e.g. `ae18d02e`).
The script extracts it from the first search response or from the seller portal URL.

---

## Tampermonkey Script

**File:** `tampermonkey/tcgplayer-export.user.js` (checked into repo for reference)

**Match:** `https://seller.tcgplayer.com/*`

**Behavior:**
1. Injects an "Export for Reseller Dashboard" button into the orders page header.
2. On click, shows a date-range prompt (default: last 3 months).
3. Extracts `sellerKey` from the first search response.
4. Paginates `POST /orders/search` (page size 100) until all orders are fetched.
5. For each order, calls `GET /orders/{orderNumber}` to get fee detail.
   - Throttles at ≤3 requests/sec to avoid rate limits.
   - Shows progress: "Fetching order 12 of 35…"
6. Builds a JSON array of enriched orders (schema below).
7. Downloads `tcgplayer-orders-YYYY-MM-DD.json`.

**Enriched order schema (output JSON):**
```json
{
  "orderNumber": "AE18D02E-28AA51-BAA99",
  "orderDate": "2026-09-26T01:25:13.767Z",
  "orderStatus": "Completed - Paid",
  "productAmount": 5.30,
  "shippingAmount": 0.00,
  "grossAmount": 5.30,
  "feeAmount": 1.01,
  "netAmount": 4.29,
  "refundStatus": "",
  "refunds": []
}
```

**Status values observed:** `Ready to Ship`, `Completed - Paid`, `Canceled`

---

## Edge Function: `import_tcgplayer_orders`

New edge function (separate from `import_marketplace_csv` — JSON input, different schema).

**Input:** JSON array of enriched orders (the file the script downloads).

**Processing per order:**

| Field | Source |
|---|---|
| `source` | `'tcgplayer'` |
| `external_order_id` | `orderNumber` |
| `sale_date` | `orderDate` (ISO 8601 → `YYYY-MM-DD`) |
| `sale_price` | `productAmount` |
| `shipping_cost` | `shippingAmount` |
| `fees` | `feeAmount` |
| `net_payout` | `netAmount` |
| `return_status` | See below |
| `platform` | `'tcgplayer'` |

**Status handling:**
- `Completed - Paid` → `return_status = 'none'`
- `Ready to Ship` → import (sale is real, just not shipped yet); `return_status = 'none'`
- `Canceled` → skip entirely (no sale record created or updated)
- `refundStatus = 'FullRefund'` → `return_status = 'full'`
- `refundStatus = 'PartialRefund'` → `return_status = 'partial'`

**Upsert key:** `(user_id, external_order_id)` — re-import safe.

**Returns:** `{ created: N, updated: N, skipped: N }`

---

## Settings UI

New upload card in `SettingsPage.tsx`, after the Mercari card:

```
TCGPlayer
Import orders via the TCGPlayer userscript.
[Install script ↗]  [Upload JSON]  [Last imported: …]
```

- No sync step (goes directly to `sales` — no `transactions` row needed).
- Upload triggers `importTCGPlayerOrders(file)` mutation.
- On success: invalidate `sales` query, show row count toast.

---

## Schema

No migrations needed. `sales.source` already allows `'tcgplayer'` via the
`sales_source_check` constraint added in a previous migration.

---

## Out of Scope (V1)

- **Settlement/payout matching** — TCGPlayer pays Mon/Thu but exposes no payout ID in
  the API. Grouping by date approximation is not worth the complexity. Omit.
- **Per-card line item auto-link** — `products[]` from the order detail is captured in
  the enriched JSON but not auto-linked to inventory lots on import. User links manually
  via the existing LinkSaleToItem flow.
- **Shipping label costs** — TCGPlayer prepaid shipping labels are not exposed in this
  API. Seller-paid shipping costs (if any) must be entered as manual expenses.

---

## File Checklist

- `tampermonkey/tcgplayer-export.user.js` — new
- `supabase/functions/import_tcgplayer_orders/index.ts` — new edge function
- `src/lib/mutations.ts` — add `importTCGPlayerOrders(file)`
- `src/pages/SettingsPage.tsx` — add TCGPlayer upload card
- `docs/features/settings.md` — document new card
- `docs/supabase-schema.md` — note `tcgplayer` source is now in use
