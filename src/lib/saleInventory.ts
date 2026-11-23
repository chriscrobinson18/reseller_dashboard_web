import type { Sale } from './types'

/**
 * The Sale panel's "Inventory" box (2026-11-23): one state per sale and the
 * action that fits it, so the owner answers "what happened to the item?"
 * instead of knowing which button maps to which scenario. Rules:
 * docs/features/sales.md "Returns & refunds workflow".
 *
 * No stored answer: the state is inferred from the sale. For a refunded sale,
 * "units taken" means the item is treated as gone (buyer kept it / lost);
 * "no units taken" means it came back or never shipped. Both are valid end
 * states, so the box shows the current one and offers the switch.
 */
export type SaleInventoryState =
  | { kind: 'trade' }                                   // handled by the trade
  | { kind: 'linked'; units: number }                   // ordinary sale, units taken
  | { kind: 'needs_link' }                              // ordinary sale, nothing taken
  | { kind: 'refund_not_out'; refunded: number }        // full refund, no units out (came back / never shipped)
  | { kind: 'refund_out'; refunded: number; units: number; canRestore: boolean } // full refund, units out (kept / lost)
  | { kind: 'partial'; refunded: number; units: number; returnedUnits: number }   // partial refund

export function unitsTaken(sale: Pick<Sale, 'inventory_movements'>): number {
  return (sale.inventory_movements ?? []).reduce((t, m) => t + Number(m.quantity ?? 0), 0)
}

export function saleInventoryState(sale: Sale): SaleInventoryState {
  if (sale.trade_id) return { kind: 'trade' }
  const units = unitsTaken(sale)
  const refunded = Number(sale.refunded_amount ?? 0)
  if (sale.return_status === 'full') {
    // An in-app return records refunded_quantity; an import never does. Only
    // an import-only refund can be reconciled in one click (no stacking).
    return units > 0
      ? { kind: 'refund_out', refunded, units, canRestore: !sale.refunded_quantity }
      : { kind: 'refund_not_out', refunded }
  }
  if (sale.return_status === 'partial') {
    return { kind: 'partial', refunded, units, returnedUnits: Number(sale.refunded_quantity ?? 0) }
  }
  return units > 0 ? { kind: 'linked', units } : { kind: 'needs_link' }
}

// ─── Item suggestions ───────────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'new', 'sealed', 'in', 'hand', 'of', 'a', 'an', 'edition', 'free', 'shipping', 'ships', 'fast', 'nm', 'mint'])

/** Lowercase words of 2+ characters (numbers kept: set and model numbers matter). */
export function titleTokens(s: string | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const w of (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (w.length >= 2 && !STOP.has(w)) out.add(w)
  }
  return out
}

/**
 * A single card: a collector number ("131/128", "- #17 -"), a card condition
 * ("Near Mint", "Lightly Played"…) or a card frame variant ("(Borderless)",
 * "(Extended Art)", "(Showcase)"), as TCGplayer titles carry. Singles come from
 * a broken-down box, so they must not be matched to a sealed product.
 */
export function looksLikeSingleCard(title: string | null | undefined): boolean {
  const t = title ?? ''
  return /\b\d{1,4}\/\d{1,4}\b/.test(t)
    || /(^|\s)#\d{1,4}\b/.test(t)
    || /\b(near mint|lightly played|moderately played|heavily played|damaged)\b/i.test(t)
    || /\((borderless|extended art|showcase|full art|foil etched|surge foil)\)/i.test(t)
}

/**
 * Items whose names best match the sale title, best first. Words are weighted
 * by rarity across your items (IDF), so brand/franchise words shared by many
 * items ("pokemon", "lego", "star wars") count for little and distinctive
 * ones (a set name, a model number) decide. Score = weight of shared words /
 * weight of the item's words; at least 0.8, and at least one shared word must
 * be distinctive (in 3 or fewer items) or a 3+ digit number. Single cards get
 * no suggestions. Suggestions only: the owner confirms.
 */
export function suggestItems<T extends { id: string; name: string }>(title: string | null | undefined, items: T[], max = 3): { item: T; score: number }[] {
  if (looksLikeSingleCard(title)) return []
  const t = titleTokens(title)
  if (t.size === 0) return []
  const tokenized = items.map(item => ({ item, words: titleTokens(item.name) }))
  const df = new Map<string, number>()
  for (const { words } of tokenized) for (const w of words) df.set(w, (df.get(w) ?? 0) + 1)
  const n = Math.max(1, items.length)
  const idf = (w: string) => Math.log(1 + n / (df.get(w) ?? 1))
  const scored: { item: T; score: number }[] = []
  for (const { item, words } of tokenized) {
    if (words.size === 0) continue
    let shared = 0, total = 0, distinctive = false
    for (const w of words) {
      const weight = idf(w)
      total += weight
      if (t.has(w)) {
        shared += weight
        if ((df.get(w) ?? 0) <= 3 || /^\d{3,}$/.test(w)) distinctive = true
      }
    }
    if (!distinctive || total === 0) continue
    const score = shared / total
    if (score >= 0.8) scored.push({ item, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, max)
}
