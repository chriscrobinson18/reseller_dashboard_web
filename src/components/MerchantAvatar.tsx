import { useState } from 'react'

interface Props {
  /** Plaid logo URL. Falls back to initial circle if null or fails to load. */
  logoUrl?: string | null
  /** Merchant name — used for the fallback initial and alt text. */
  merchant: string | null
  /** Pixel size of the square avatar. Default 32. */
  size?: number
}

/**
 * Square avatar for a merchant. Renders the Plaid logo when available, falls
 * back to a gray circle with the first letter of the merchant name. Layout
 * is identical in both cases so the slot doesn't jump when an image loads
 * or fails.
 */
export default function MerchantAvatar({ logoUrl, merchant, size = 32 }: Props) {
  const [broken, setBroken] = useState(false)
  const dim = { width: size, height: size }
  const initial = (merchant ?? '?').trim().charAt(0).toUpperCase() || '?'

  if (logoUrl && !broken) {
    return (
      <img
        src={logoUrl}
        alt={merchant ?? 'Merchant logo'}
        onError={() => setBroken(true)}
        className="rounded-full bg-gray-100 object-contain"
        style={dim}
      />
    )
  }

  return (
    <div
      className="rounded-full bg-gray-100 text-gray-500 flex items-center justify-center font-medium"
      style={{ ...dim, fontSize: Math.max(12, Math.floor(size * 0.45)) }}
      aria-label={merchant ?? 'Merchant'}
    >
      {initial}
    </div>
  )
}
