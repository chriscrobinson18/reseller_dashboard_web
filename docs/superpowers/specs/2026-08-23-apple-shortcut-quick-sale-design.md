# Apple Shortcut — Quick Sale & Breakdown Entry

**Date:** 2026-08-23
**Status:** Approved, pending implementation

## Overview

An Apple Shortcut accessible from mobile Safari that lets a user record either a **quick sale** or a **quick breakdown** from their iPhone. Auth uses a per-user one-time token stored in `profiles`. No FIFO inventory depletion — records appear as incomplete entries in the web app, highlighted with ⚠️ banners, for the user to complete later.

---

## 1. Schema Changes

Three migrations required:

### `profiles` table
Add column:
```sql
shortcut_token uuid UNIQUE DEFAULT NULL
```
Nullable. One token per user. Replacing it invalidates the old one immediately.

### `sales` table
Add column:
```sql
item_name text DEFAULT NULL
```
Nullable free-text field populated by the shortcut. Persists after the sale is linked to an inventory item.

### `box_openings` table
Relax two constraints to allow shortcut-initiated (incomplete) records:
- `box_cost`: change CHECK from `> 0` to `IS NULL OR > 0` — null when no source lot is linked
- `allocation_method`: make nullable — null until the user completes the breakdown in the web app

---

## 2. Edge Functions

### `shortcut_record_sale`

**Auth:** Service role. Token-based identity.

**Request:**
```json
POST /functions/v1/shortcut_record_sale
{
  "shortcut_token": "uuid",
  "item_name": "Jordan 1 Retro High OG",
  "quantity": 1,
  "sale_price": 250.00,
  "payment_method": "venmo"
}
```

**Logic:**
1. Look up `user_id` from `profiles.shortcut_token`
2. Insert `sales` row: `source: 'manual'`, `platform: 'manual'`, `item_id: null`, `item_name`, `quantity`, `sale_price`, `payment_method`, `sold_at: today`, `fees: 0`, `shipping_cost: 0`, `net_payout: sale_price`, `inventory_status: 'ok'`, `return_status: 'none'`
3. Return `{ success: true, sale_id }`

---

### `shortcut_record_breakdown`

**Auth:** Service role. Token-based identity.

**Request:**
```json
POST /functions/v1/shortcut_record_breakdown
{
  "shortcut_token": "uuid",
  "item_name": "Topps Blaster Box",
  "quantity": 1
}
```

**Logic:**
1. Look up `user_id` from `profiles.shortcut_token`
2. Insert `box_openings` row: `box_name: item_name`, `quantity`, `opened_at: today`, `source_lot_id: null`, `box_cost: null`, `allocation_method: null`
3. Return `{ success: true, box_opening_id }`

Incomplete breakdowns (source_lot_id IS NULL) are detected by the web app UI to show the ⚠️ banner.

---

## 3. Web UI — ⚠️ Attention Banners

### Sales page banner
Shown above the sales table when any sale has `item_id IS NULL AND item_name IS NOT NULL`.

```
⚠️  2 sales need attention — item not linked to inventory
[collapse ▲]
  • Jordan 1 Retro High OG — $250 — Venmo — Aug 23     [dismiss]
  • Topps Chrome — $45 — Cash — Aug 23                  [dismiss]
```

"Dismiss" soft-deletes the sale (same as regular delete). Clicking a row opens the existing edit/link flow.

### Inventory page banner
Shown between the action buttons row and the main inventory table when any `box_openings` row has `source_lot_id IS NULL`.

```
⚠️  1 breakdown needs completion — source item not linked
[collapse ▲]
  • Topps Blaster Box — 1 unit — Aug 23     [delete]
```

"Delete" permanently removes the incomplete breakdown. Each row has a note: "Open 'Breakdown Inventory' to complete."

---

## 4. Settings: Apple Shortcuts Card

**Location:** New section in `src/pages/SettingsPage.tsx`.

### States

**No token:**
```
[ Apple Shortcuts ]
Record sales and breakdowns quickly from your iPhone.
[ Generate Token ]
```

**Token exists:**
```
[ Apple Shortcuts ]
<uuid shown in full>   [ Copy ]
[ Add to Shortcuts ]   [ Regenerate ]
```

- **Generate Token**: `crypto.randomUUID()` client-side, upserted to `profiles.shortcut_token`
- **Copy**: copies UUID to clipboard, shows "Copied!" briefly
- **Add to Shortcuts**: `<a href="/reseller-sale.shortcut" download>`
- **Regenerate**: `ConfirmDialog` → new UUID

---

## 5. Apple Shortcut

**Distribution:** Static `.shortcut` file at `public/reseller-sale.shortcut`, built manually in the Shortcuts app.

### Flow

```
1. Token check: read "ResellerConfig" dictionary
   └── If "token" empty: prompt "Paste your Shortcut Token" → save

2. Choose from List: "Record a Sale" | "Break Down Inventory"

── If "Record a Sale" ──────────────────────────────────────────
3. Ask text:   "What did you sell?"
4. Ask number: "Quantity?" (default 1)
5. Ask number: "Sale price?"
6. Choose list: Cash / Venmo / Cash App / PayPal / Apple Pay / Zelle / Card / Other
   Map to value: cash / venmo / cashapp / paypal / apple_pay / zelle / card / other
7. POST shortcut_record_sale → { shortcut_token, item_name, quantity, sale_price, payment_method }
8. Notify: "Sale recorded — <item_name> $<sale_price>"

── If "Break Down Inventory" ───────────────────────────────────
3. Ask text:   "What are you breaking down?"
4. Ask number: "Quantity?" (default 1)
5. POST shortcut_record_breakdown → { shortcut_token, item_name, quantity }
6. Notify: "Breakdown recorded — <item_name> ×<quantity>"

── Error (either path) ─────────────────────────────────────────
→ Show Alert: "Error: <response.error>"
```

---

## 6. What This Does NOT Do

- No FIFO inventory depletion — sales and breakdowns are unlinked at creation
- No linked `transactions` rows — fees/shipping not entered via shortcut
- No date override — always records as today UTC
- No `sale_bundles` support — one item per shortcut run

---

## 7. File Checklist

| Artifact | Path |
|---|---|
| Migration: sales.item_name | `supabase/migrations/20260823100000_add_item_name_to_sales.sql` |
| Migration: profiles.shortcut_token | `supabase/migrations/20260823100001_add_shortcut_token_to_profiles.sql` |
| Migration: box_openings constraints | `supabase/migrations/20260823100002_relax_box_openings_for_shortcut.sql` |
| Edge function: sale | `supabase/functions/shortcut_record_sale/index.ts` |
| Edge function: breakdown | `supabase/functions/shortcut_record_breakdown/index.ts` |
| Query: incomplete breakdowns | `src/lib/queries.ts` (new `useIncompleteBreakdowns` hook) |
| Sales page banner | `src/pages/SalesPage.tsx` |
| Inventory page banner | `src/pages/InventoryPage.tsx` |
| Settings card | `src/components/ShortcutsSettingsCard.tsx` |
| Settings page | `src/pages/SettingsPage.tsx` |
| Shortcut file | `public/reseller-sale.shortcut` |
| Docs | `docs/supabase-schema.md`, `docs/features/sales.md` |
