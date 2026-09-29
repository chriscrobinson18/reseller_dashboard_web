# Amazon Date Range Transaction Report Parser

**Date:** 2026-09-29
**Status:** Approved for implementation

---

## Background

Current Amazon import uses Transaction View (TV) downloaded from the Payments tab. TV groups transactions by calendar month (`amz_tv_YYYY-MM`), has no settlement IDs, and no Transfer rows — so Settlement Status cannot compute expected deposits for Amazon.

The Date Range Transaction Report (from Reports → Payments → Date Range) includes settlement IDs and Transfer rows, enabling Settlement Status matching. It also provides per-order shipping label costs, improving profit accuracy.

---

## Goals

1. Parse Amazon Date Range Transaction Report CSV
2. Enable Settlement Status matching for Amazon (Transfer rows → expected deposit)
3. Capture per-order shipping label costs in transactions
4. Filter Deferred rows (not yet released to payout)
5. Remain backward-compatible — Transaction View and old Settlement Report CSVs still work

---

## Format

**Download path:** Seller Central → Reports → Payments → Date Range Reports → Transaction

**Detection:** header row contains both `settlement id` AND `transaction status` columns (distinct from TV which has `transaction type`, and old SR which has `product details`).

**Header columns (relevant):**
`date/time`, `settlement id`, `type`, `order id`, `description`, `product sales`, `selling fees`, `fba fees`, `other transaction fees`, `other`, `total`, `Transaction Status`, `Transaction Release Date`

**Date format:** `"Jan 3, 2025 5:19:39 PM PST"` — parse date portion only (existing `parseDateAny` handles `"Jan 3, 2025"`)

**Amount format:** commas in large amounts (e.g., `"-1,364.69"`) — existing `parseAmount` strips commas.

---

## Type Mapping

| Type | Rows created | schedule_c_category | Notes |
|---|---|---|---|
| `Order` | 1–3 | product_sales → `payout`; selling_fees → `commissions_fees`; fba_fees → `commissions_fees` | Skip zero components |
| `Shipping Services` | 1 | `shipping_postage` | amount = `total`; merchant from description |
| `Refund` | 1 | `payout` | amount = `total` (negative) |
| `Transfer` | 1 | `transfer` | Drives Settlement Status expected deposit |
| `Service Fee` | skip | — | total = 0; Amazon subscription fee |
| `Debt` | 1 | `balance_adjustment` | Cross-settlement carry-forward |

**Skip rule:** any row where `Transaction Status = "Deferred"` is skipped — not yet released to payout and will re-appear when released.

---

## Dedup Keys

Prefix: `amz_dr_` (distinct from `amz_tv_` and `amz_sr_`)

| Row type | Key |
|---|---|
| Order product sales | `amz_dr_${settlementId}_${safeOrder}_sales` |
| Order selling fees | `amz_dr_${settlementId}_${safeOrder}_fees` |
| Order FBA fees | `amz_dr_${settlementId}_${safeOrder}_fba` |
| Shipping Services — label | `amz_dr_${settlementId}_${safeOrder}_ship` |
| Shipping Services — return | `amz_dr_${settlementId}_${safeOrder}_return_ship` |
| Shipping Services — adj | `amz_dr_${settlementId}_${safeOrder}_ship_adj` |
| Refund | `amz_dr_${settlementId}_${safeOrder}_refund` |
| Transfer | `amz_dr_${settlementId}_transfer` |
| Debt | `amz_dr_${settlementId}_debt` |

`safeOrder` = order ID with non-alphanumeric chars replaced by `_`.

---

## Shipping Services Merchant Labels

| Description contains | merchant |
|---|---|
| `Shipping Label Purchased through Amazon` | `Amazon Shipping Label` |
| `ReturnPostageBilling` | `Amazon Return Label` |
| `Adjustment` | `Amazon Shipping Adjustment` |
| anything else | `Amazon Shipping Services` |

---

## CSV Group Assignment

All rows in the same settlement → `csv_group_id = settlementId` (same as old SR).

This enables `useCSVGroups` and Settlement Status to work for Amazon with no UI changes.

---

## Detection Logic (within `amazon` branch)

```
if hasSettlementId AND hasTransactionStatus → new Date Range format
else if hasSettlementId AND hasProductDetails → old Settlement Report format
else → Transaction View format
```

`amazon_format` response field returns `'date_range'` for diagnostics.

---

## Backward Compatibility

- Existing `amz_tv_*` and `amz_sr_*` rows are unaffected
- TV and old SR parsers remain active
- Single `platform = 'amazon'` upload card — format auto-detected
- `ignoreDuplicates: true` upsert — re-importing safe

---

## Out of Scope

- Migrating existing TV data to DR format
- Parsing `marketplace withheld tax`, `shipping credits`, `gift wrap credits`, `promotional rebates` as separate transactions (add later if needed; negligible for Schedule C)
- Per-order profit calculation (requires linking DR transactions to `sales` rows — separate feature)
