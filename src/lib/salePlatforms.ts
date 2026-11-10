/**
 * Platforms offered in the Record Sale / Edit Sale / Edit Bundle forms.
 * One shared list so the three forms can't drift apart.
 *
 * The value is stored in `sales.platform` (free text, no DB constraint). The
 * Year-End Tie-Out pairs sales with settlement deposits by this value, so a
 * venue that pays out by bank deposit needs its own entry matching the
 * deposit's `transactions.platform` label (e.g. `goldin`, added 2026-11-10
 * for auction-house consignment sales).
 */
export const SALE_PLATFORMS = [
  'ebay', 'amazon', 'tcgplayer', 'mercari', 'stockx', 'goat', 'whatnot', 'goldin',
  'facebook marketplace', 'facebook groups', 'discord', 'manual',
] as const
