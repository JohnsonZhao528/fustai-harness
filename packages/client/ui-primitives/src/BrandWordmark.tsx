import type { IconProps } from './icons/props.ts'
import { BRAND_MARK_DATA_URI } from './brandMark.ts'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading brand mark; defaults to true. */
  includeMark?: boolean | undefined
}

/** Font stack for the rendered wordmark and badge text. */
const WORDMARK_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

/** Wordmark lettering; brand art, not translatable copy. */
const WORDMARK_NAME = 'FustAI'

/** Badge lettering; brand art, not translatable copy. */
const WORDMARK_BADGE = 'HARNESS'

/** Gap between mark, name, and badge; about two name letters wide at 18px. */
const WORDMARK_GAP = 16

/** Width of the 18px semibold name lettering. */
const NAME_WIDTH = 56

/** Width of the HARNESS badge pill. */
const BADGE_WIDTH = 52

/** Height of the HARNESS badge pill. */
const BADGE_HEIGHT = 14

/**
 * Render the full brand wordmark.
 * @param props.size - height in px (default 24; width follows the lettering).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading brand mark.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const nameX = includeMark ? 24 + WORDMARK_GAP : 0
  const badgeX = nameX + NAME_WIDTH + WORDMARK_GAP
  const width = badgeX + BADGE_WIDTH
  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={className}
      viewBox={`0 0 ${width} 24`}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && <image href={BRAND_MARK_DATA_URI} x="0" y="0" width="24" height="24" />}
      <text
        x={nameX}
        y="18"
        fontFamily={WORDMARK_FONT}
        fontSize="18"
        fontWeight="600"
        fill="currentColor"
      >
        {WORDMARK_NAME}
      </text>
      <rect x={badgeX} y={(24 - BADGE_HEIGHT) / 2} width={BADGE_WIDTH} height={BADGE_HEIGHT} rx="2" fill="currentColor" />
      <text
        x={badgeX + BADGE_WIDTH / 2}
        y="15.5"
        textAnchor="middle"
        fontFamily={WORDMARK_FONT}
        fontSize="9.5"
        fontWeight="700"
        fill="var(--dsw-alias-label-primary-inverted)"
      >
        {WORDMARK_BADGE}
      </text>
    </svg>
  )
}
