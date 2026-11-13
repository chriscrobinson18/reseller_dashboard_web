# Card Reselling Inventory SOP

_Inventory method: traditional §471 (owner decision 2026-11-09; this SOP was written for §471(c) NIMS and updated 2026-11-13) · Last updated 2026-11-13_

---

## The Core Rule

Track cards you list individually. Pool everything else. Estimate cost when you can't trace it to a specific box — just be consistent.

---

## 1. Buying a Box (or Batch of Boxes)

**In the app:** Add a new inventory lot immediately when you buy.

| Field | What to enter |
|---|---|
| Item name | Box type (e.g. "Pokemon Surging Sparks Booster Box") |
| Quantity | Number of boxes |
| Unit cost | What you paid per box (including shipping) |
| Purchase date | Actual purchase date |

**If you buy 5 boxes of the same type the same week:** one lot, qty 5, is fine. You'll pull from this pool as you open.

---

## 2. Opening a Box

**Sort first, then record.** Two piles:

- **Notable:** any card you'll list for $2 or more
- **Bulk:** everything else (commons, low-value duplicates)

**Estimate cost per notable pull:**

> Box cost ÷ number of notable cards pulled = estimated cost per card

Example: $120 box, you pull 8 cards worth listing → ~$15 estimated cost each. The remaining basis ($120 − assigned notable costs) goes to bulk.

You don't need exact FMV allocation — a consistent estimate is enough.

**In the app (two options):**

_Option A — Use the Breakdown feature:_
- Open the box lot → Breakdown Inventory
- Create one child lot per notable card (qty 1, estimated cost)
- Create one "Bulk" child lot for the remainder (all remaining qty + basis)

_Option B — Skip breakdown, use the box lot directly:_
- Leave the box lot as-is
- When you record a sale, deplete from the box lot and manually enter the estimated unit cost
- Works fine if you don't need per-card lot history

Use Option A for boxes where individual cards are worth $25+. Option B is fine for typical $5–$15 range pulls.

---

## 3. Listing a Card for Sale

No app action needed at listing time. Record the sale when it actually sells (next section).

If you're listing something valuable ($50+), add it as a named inventory lot now so it's easy to link when it sells.

---

## 4. Recording a Sale

**In the app:** Record Sale → link to the lot (or box pool lot).

| Card sold for | COGS to record |
|---|---|
| Listed individually ($2+) | Estimated cost from step 2 |
| Sold in a bulk lot deal | Remaining balance of the bulk lot |
| Sold at a show (cash) | Same — estimate from batch cost |

If you can't remember which box a card came from: use the average cost from your most recent batch of that box type. Document the estimate in the Notes field.

---

## 5. Bulk Disposal

When you sell a pile of commons (lot deal, show table, eBay bulk lot):

- Record as a single sale
- Link to the "Bulk" lot (or the box pool lot)
- COGS = whatever basis remains on that lot
- If bulk never sells: it carries forward as inventory at near-zero cost — no tax impact until sold

You do not need to count individual bulk cards.

---

## 6. What to Do When You Don't Know the Box Origin

This will happen. Use this fallback:

1. Look at your recent purchases for that card type
2. Calculate average cost per notable pull across those boxes
3. Use that as the basis for the card
4. Add a note: "Estimated basis — avg cost from [month] [box type] batch"

Being consistent matters more than being exact. Use the same method every time for the same situation.

---

## 7. Year-End (traditional §471)

Cost of goods sold = beginning inventory + purchases − **ending inventory**, so the year-end inventory value matters: unsold cards and boxes are carried into next year, not deducted this year.

At year-end:
- All boxes and cards bought this year are recorded in the app as lots
- Sales are linked to lots, so the lots left on hand are the ending inventory
- Dashboard → **Part III card**: save the year-end value. It suggests a lot-based figure (units on hand × cost); use it, or a count / estimate if lots are incomplete, and note how it was determined
- Run "Apply Rules Now" in Settings if anything is uncategorized

What to export for your return:
- Dashboard → **Summary CSV** with the "Last Year" period: Line 4 comes from Part III (beginning + purchases − ending)
- Keep your lot records in the app as documentation if ever questioned

---

## Thresholds at a Glance

| Situation | Action |
|---|---|
| Card selling for $2+ (individually listed) | Create a lot or deplete from box pool with estimated cost |
| Card selling for $25+ | Named lot, traced to specific box if possible |
| Card selling for $100+ | Specific lot, document the box it came from |
| Bulk / commons | Pool into one bulk lot per box or per batch |
| Unknown box origin | Use average cost from same box type batch, note it |

---

## What You Don't Need to Do

- Count every individual card in a box
- Track commons that will never sell individually
- Create a separate lot for every $0.50 card
