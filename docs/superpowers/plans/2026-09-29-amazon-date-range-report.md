# Amazon Date Range Transaction Report Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parser for Amazon's Date Range Transaction Report (Reports → Payments → Date Range) inside `import_marketplace_csv`, enabling Settlement Status matching and per-order shipping label costs.

**Architecture:** Auto-detect the new format within the existing `amazon` platform branch by checking for `transaction status` column in the header. Add a third parser path (`isDateRange`) alongside the existing TV and SR paths. Dedup key prefix `amz_dr_` avoids collision with existing rows.

**Tech Stack:** Supabase Edge Functions (Deno/TypeScript), existing `parseAmount`, `parseDateAny`, `notDash` helpers.

---

## Files

| Action | File |
|---|---|
| Modify | `supabase/functions/import_marketplace_csv/index.ts` — detection + parser |
| Modify | `src/pages/SettingsPage.tsx` — update Amazon upload description |

---

### Task 1: Add Date Range detection and parser to `import_marketplace_csv`

**Files:**
- Modify: `supabase/functions/import_marketplace_csv/index.ts`

**Context:** The amazon branch (lines 126–355) has:
- A detection loop (lines 130–159) that sets `headerIdx` and `isTransactionView`
- A shared `header` (lowercased array) and `col`/`colAny` helpers (lines 165–173)
- Two parser paths: `if (isTransactionView)` (TV) and `else` (old SR)

The Date Range format has `settlement id` + `transaction status` columns. The old SR format has `settlement id` + `product details`. Current detection would misroute DR rows into the SR parser. Fix: add `isDateRange` flag + DR detection before the existing `hasSettlementId` block.

---

- [ ] **Step 1: Update version comment**

Find:
```typescript
// import_marketplace_csv v19
```

Replace with:
```typescript
// import_marketplace_csv v20
// Add: Amazon Date Range Transaction Report parser (amz_dr_* keys). Auto-detected
//      from header: has 'settlement id' + 'transaction status'. Enables Settlement
//      Status for Amazon and captures per-order shipping label costs. Deferred rows
//      (Transaction Status=Deferred) are skipped — not yet released to payout.
// Prior: import_marketplace_csv v19
```

---

- [ ] **Step 2: Add `isDateRange` flag to the amazon detection block**

Find (line 127–128):
```typescript
      let headerIdx = -1
      let isTransactionView = false
```

Replace with:
```typescript
      let headerIdx = -1
      let isTransactionView = false
      let isDateRange = false
```

---

- [ ] **Step 3: Add Date Range detection before the existing `hasSettlementId` block**

Find (lines 130–158, inside the detection loop):
```typescript
        // True Transaction View (Python-style): has 'product details' or 'total product charges'
        if (hasProductDetails || hasTotalCharges) {
          headerIdx = i; isTransactionView = true; break
        }
        // Standard SR / Transaction View hybrid: settlement id present
```

Replace with:
```typescript
        // True Transaction View (Python-style): has 'product details' or 'total product charges'
        if (hasProductDetails || hasTotalCharges) {
          headerIdx = i; isTransactionView = true; break
        }
        // New Date Range Transaction Report: has settlement id + transaction status
        const hasTransactionStatus = norm.includes('transaction status')
        if (hasSettlementId && hasTransactionStatus) {
          headerIdx = i; isDateRange = true; break
        }
        // Standard SR / Transaction View hybrid: settlement id present
```

---

- [ ] **Step 4: Update `amazonFormat` assignment to include `date_range`**

Find (line 166):
```typescript
      amazonFormat = isTransactionView ? 'transaction_view' : 'settlement_report'
```

Replace with:
```typescript
      amazonFormat = isDateRange ? 'date_range' : isTransactionView ? 'transaction_view' : 'settlement_report'
```

---

- [ ] **Step 5: Add the Date Range parser branch**

Find (line 175–176):
```typescript
      // ── Amazon Transaction View (Python-style CSV) ────────────────────────
      if (isTransactionView) {
```

Insert immediately before that block:
```typescript
      // ── Amazon Date Range Transaction Report ──────────────────────────────
      if (isDateRange) {
        for (let i = headerIdx + 1; i < allRows.length; i++) {
          const r = allRows[i]
          const dateRaw     = col(r, 'date/time')
          const settlementId = col(r, 'settlement id')
          const type         = col(r, 'type')
          const orderId      = col(r, 'order id')
          const description  = col(r, 'description')
          const txStatus     = col(r, 'transaction status')

          if (txStatus === 'Deferred') { trackSkip('deferred'); continue }

          const date = parseDateAny(dateRaw)
          if (!date) { trackSkip('bad_date'); continue }
          if (!settlementId) { trackSkip('no_settlement_id'); continue }

          const safeOrder = orderId.replace(/[^a-zA-Z0-9_-]/g, '_')
          const groupId   = settlementId

          const productSales = parseAmount(col(r, 'product sales'))
          const sellingFees  = parseAmount(col(r, 'selling fees'))
          const fbaFees      = parseAmount(col(r, 'fba fees'))
          const total        = parseAmount(col(r, 'total'))

          if (type === 'Order') {
            if (productSales !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: productSales, gross_amount: productSales,
                merchant: description || orderId || 'Amazon Sale',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'payout', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_${safeOrder}_sales`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            }
            if (sellingFees !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: sellingFees, gross_amount: null,
                merchant: 'Amazon Fees',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'commissions_fees', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_${safeOrder}_fees`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            }
            if (fbaFees !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: fbaFees, gross_amount: null,
                merchant: 'Amazon FBA Fees',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'commissions_fees', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_${safeOrder}_fba`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            }
            if (productSales === 0 && sellingFees === 0 && fbaFees === 0) trackSkip('order_all_zero')

          } else if (type === 'Shipping Services') {
            if (total !== 0) {
              const descLower = description.toLowerCase()
              const isReturn  = descLower.includes('returnpostage') || descLower.includes('return postage')
              const isAdj     = descLower.includes('adjustment')
              const merchant  = isReturn ? 'Amazon Return Label' : isAdj ? 'Amazon Shipping Adjustment' : 'Amazon Shipping Label'
              const suffix    = isReturn ? 'return_ship' : isAdj ? 'ship_adj' : 'ship'
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: total, gross_amount: null,
                merchant,
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'shipping_postage', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_${safeOrder}_${suffix}`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            } else { trackSkip('shipping_zero') }

          } else if (type === 'Refund') {
            if (total !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: total, gross_amount: null,
                merchant: description || (orderId ? `Amazon Refund ${orderId}` : 'Amazon Refund'),
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'payout', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_${safeOrder}_refund`,
                csv_group_id: groupId, notes: orderId || null, parent_settlement_id: null })
            } else { trackSkip('refund_zero') }

          } else if (type === 'Transfer') {
            if (total !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: total, gross_amount: null,
                merchant: 'Amazon Transfer',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'transfer', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_transfer`,
                csv_group_id: groupId, notes: null, parent_settlement_id: null })
            } else { trackSkip('transfer_zero') }

          } else if (type === 'Debt') {
            if (total !== 0) {
              rowsParsed++
              transactions.push({ user_id: user.id, date, amount: total, gross_amount: null,
                merchant: 'Amazon Debt Carry',
                type: 'other', source: 'csv_import', platform: 'amazon',
                schedule_c_category: 'balance_adjustment', record_type: 'transaction',
                csv_transaction_id: `amz_dr_${settlementId}_debt`,
                csv_group_id: groupId, notes: null, parent_settlement_id: null })
            } else { trackSkip('debt_zero') }

          } else if (type === 'Service Fee') {
            trackSkip('intentional:ServiceFee')
          } else {
            trackSkip(`amz_dr_type:${type || 'empty'}`)
          }
        }

      // ── Amazon Transaction View (Python-style CSV) ────────────────────────
      } else if (isTransactionView) {
```

**Important:** The line `if (isTransactionView) {` you found in step becomes `} else if (isTransactionView) {` — add the `} else` prefix.

---

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors.

---

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/import_marketplace_csv/index.ts
git commit -m "feat: add Amazon Date Range Transaction Report parser (v20)"
```

---

### Task 2: Update Settings upload card description

**Files:**
- Modify: `src/pages/SettingsPage.tsx`

- [ ] **Step 1: Update Amazon description**

Find:
```tsx
            description="Seller Central → Reports → Payments → Transaction View"
```

Replace with:
```tsx
            description="Seller Central → Reports → Payments → Date Range Reports (or Transaction View)"
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/SettingsPage.tsx
git commit -m "fix: update Amazon upload card description for Date Range report"
```

---

### Task 3: Deploy and manual verify

- [ ] **Step 1: Deploy edge function**

```bash
supabase functions deploy import_marketplace_csv
```

Expected: `Deployed Functions on project qmizmnbzergqbpgyqseg: import_marketplace_csv`

- [ ] **Step 2: Manual test — upload the Date Range CSV**

In the running app (Settings → Marketplace CSV → Amazon):
1. Upload the Date Range Transaction Report CSV
2. Expected success banner: rows_parsed > 0, `amazon_format: date_range`
3. Check Settings → Settlement Status → Amazon tab — groups with numeric IDs (settlement IDs) should appear
4. Groups with Transfer rows should show an expected deposit amount

- [ ] **Step 3: Verify Settlement Status shows expected deposits**

Open a settlement group that had a Transfer row in the CSV. Expected:
- Summary shows non-zero "Expected deposit"
- "Find Plaid Match" button is active
- Clicking it finds the corresponding bank deposit

- [ ] **Step 4: Verify re-import is idempotent**

Upload the same CSV again. Expected: rows_parsed same count, 0 new rows inserted (ignoreDuplicates — existing `amz_dr_*` keys are skipped silently).

- [ ] **Step 5: Push to remote**

```bash
git push origin main
```

---

## Manual Verification Checklist

After all tasks complete:

- [ ] Upload Date Range CSV → success banner shows `amazon_format: date_range`
- [ ] Settlement Status → Amazon tab shows settlement ID groups (not `amz_tv_*` monthly groups)
- [ ] Groups with Transfer rows show expected deposit
- [ ] "Find Plaid Match" finds bank deposits for matched groups
- [ ] Old TV CSVs still import correctly (upload one to verify — should show `amazon_format: transaction_view`)
- [ ] Re-uploading same DR CSV produces same row count with 0 duplicates
- [ ] Deferred rows are skipped (check `skipped_breakdown` in response for `deferred` key if any exist)
