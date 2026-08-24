# Apple Shortcut — Quick Sale Entry

**Date:** 2026-08-23
**Status:** Approved, pending implementation

## Overview

An Apple Shortcut accessible from mobile Safari that lets a user record an unlinked manual sale in 4 prompts (item name, quantity, price, payment method). Auth uses a per-user one-time token stored in `profiles`. No FIFO inventory depletion — the sale appears in the web app as an unlinked manual entry that can be linked to an inventory item later.

---

## 1. Schema Changes

Two migrations required:

### `profiles` table
Add column:
```sql
shortcut_token uuid UNIQUE DEFAULT NULL
```
Nullable. One token per user. Replacing it invalidates the old one immediately (unique constraint enforces single active token).

### `sales` table
Add column:
```sql
item_name text DEFAULT NULL
```
Nullable free-text field populated by the shortcut. Persists after the sale is linked to an inventory item — serves as a human-readable hint for what was sold.

---

## 2. Edge Function: `shortcut_record_sale`

**Path:** `supabase/functions/shortcut_record_sale/index.ts`
**Auth:** Uses Supabase service role internally (no JWT from caller). Token-based identity.

### Request
```json
POST /functions/v1/shortcut_record_sale
Content-Type: application/json

{
  "shortcut_token": "uuid",
  "item_name": "Jordan 1 Retro High OG",
  "quantity": 1,
  "sale_price": 250.00,
  "payment_method": "venmo"
}
```

### Logic
1. Look up `user_id` from `profiles` where `shortcut_token = $shortcut_token`
2. If not found → return 401 `{ error: "Invalid shortcut token" }`
3. Compute `sold_at` = current UTC date (`YYYY-MM-DD`)
4. Insert into `sales`:
   - `user_id` — from lookup
   - `item_id` — null (unlinked)
   - `item_name` — from request
   - `quantity` — from request
   - `sale_price` — from request
   - `payment_method` — from request
   - `source` — `'manual'`
   - `platform` — `'manual'`
   - `sold_at` — today UTC
   - `fees` — `0`
   - `shipping_cost` — `0`
   - `net_payout` — `sale_price` (no fees/shipping at entry time)
   - `inventory_status` — `'ok'`
   - `return_status` — `'none'`
5. Return `{ success: true, sale_id: "<uuid>" }`

### Error responses
| Case | Status | Body |
|---|---|---|
| Invalid/missing token | 401 | `{ error: "Invalid shortcut token" }` |
| Missing required field | 400 | `{ error: "Missing field: <name>" }` |
| DB error | 500 | `{ error: "<message>" }` |

---

## 3. Web UI — Settings: Apple Shortcuts Card

**Location:** New card in the existing Settings page (or wherever app settings live).

### States

**No token generated yet:**
```
[ Apple Shortcuts ]
Record sales quickly from your iPhone.
[ Generate Token ]
```

**Token exists:**
```
[ Apple Shortcuts ]
Your shortcut token:
••••••••-••••-••••-••••-f3a2c1b09e44   [ Copy ]

[ Add to Shortcuts ]   [ Regenerate ]
```

### Behavior
- **Generate Token**: calls `crypto.randomUUID()` client-side, writes to `profiles.shortcut_token` via upsert
- **Copy**: copies raw token UUID to clipboard, shows brief "Copied!" confirmation
- **Add to Shortcuts**: links to the hosted `.shortcut` file (e.g. `/shortcut/reseller-sale.shortcut` served from Vercel static assets)
- **Regenerate**: shows `ConfirmDialog` — "This will invalidate your current Shortcut. Continue?" — then generates and saves a new UUID

Token display: shows last 12 chars unmasked so user can verify they have the right token in the Shortcuts app.

---

## 4. Apple Shortcut

**Distribution:** Static `.shortcut` file hosted at a public Vercel path (e.g. `/public/reseller-sale.shortcut`). Tapping "Add to Shortcuts" downloads it; iOS prompts to install.

### Flow

```
1. Read Dictionary "ResellerConfig" from local storage
   └── If "token" key is empty or missing:
       a. Ask for Input (text): "Paste your Shortcut Token from the app's Settings"
       b. Set Dictionary key "token" = input
       c. Save Dictionary to local storage

2. Ask for Input (text):    "What did you sell?"
3. Ask for Input (number):  "Quantity?" — default: 1
4. Ask for Input (number):  "Sale price?"
5. Choose from List:        Cash / Venmo / Cash App / PayPal / Apple Pay / Zelle / Card / Other
   └── Map label → value:  cash / venmo / cashapp / paypal / apple_pay / zelle / card / other

6. Get Contents of URL:
   URL:    https://<project-ref>.supabase.co/functions/v1/shortcut_record_sale
   Method: POST
   Headers: Content-Type: application/json
   Body (JSON):
     {
       "shortcut_token": <token from step 1>,
       "item_name":      <step 2>,
       "quantity":       <step 3>,
       "sale_price":     <step 4>,
       "payment_method": <step 5 value>
     }

7. If response contains "success":
   → Show Notification: "Sale recorded — <item_name> $<sale_price>"
   Else:
   → Show Alert: "Error: <response.error>"
```

### Token storage
Uses a Shortcuts Dictionary stored in a local Text variable named `ResellerConfig`. Persists between runs within the Shortcuts app. User only pastes token once unless they regenerate it.

---

## 5. What This Does NOT Do

- No FIFO inventory depletion — sale is unlinked at creation
- No linked `transactions` rows — fees/shipping not entered via shortcut
- No `sale_bundles` support — one item per shortcut run
- No date override — always records as today (UTC)

These are all available in the web app when the user links and edits the sale after the fact.

---

## 6. File Checklist

| Artifact | Path |
|---|---|
| Migration: profiles.shortcut_token | `supabase/migrations/<ts>_add_shortcut_token_to_profiles.sql` |
| Migration: sales.item_name | `supabase/migrations/<ts>_add_item_name_to_sales.sql` |
| Edge function | `supabase/functions/shortcut_record_sale/index.ts` |
| Settings UI card | `src/components/ShortcutSettingsCard.tsx` (or inline in Settings page) |
| Shortcut file | `public/reseller-sale.shortcut` |
| Docs update | `docs/supabase-schema.md` (new columns), `docs/features/sales.md` (item_name field) |
