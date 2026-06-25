// 12-swatch fixed palette for custom Schedule C categories.
// Each entry is a (text-color, background-color) pair tuned to look like
// the built-in CATEGORIES badges. The color_key column on custom_categories
// stores one of these keys; resolveCategory() looks up the swatch at render.

export type ColorKey =
  | 'emerald' | 'sky'   | 'rose'   | 'amber'
  | 'violet'  | 'slate' | 'orange' | 'teal'
  | 'indigo'  | 'pink'  | 'lime'   | 'cyan'

export const PALETTE: Record<ColorKey, { color: string; bgColor: string }> = {
  emerald: { color: '#059669', bgColor: '#d1fae5' },
  sky:     { color: '#0284c7', bgColor: '#e0f2fe' },
  rose:    { color: '#e11d48', bgColor: '#ffe4e6' },
  amber:   { color: '#d97706', bgColor: '#fef3c7' },
  violet:  { color: '#7c3aed', bgColor: '#ede9fe' },
  slate:   { color: '#6b7280', bgColor: '#f3f4f6' },
  orange:  { color: '#ea580c', bgColor: '#ffedd5' },
  teal:    { color: '#0d9488', bgColor: '#ccfbf1' },
  indigo:  { color: '#4f46e5', bgColor: '#eef2ff' },
  pink:    { color: '#db2777', bgColor: '#fce7f3' },
  lime:    { color: '#65a30d', bgColor: '#ecfccb' },
  cyan:    { color: '#0891b2', bgColor: '#cffafe' },
}

export const PALETTE_KEYS: ColorKey[] = Object.keys(PALETTE) as ColorKey[]

export function isColorKey(s: string): s is ColorKey {
  return (PALETTE_KEYS as string[]).includes(s)
}
