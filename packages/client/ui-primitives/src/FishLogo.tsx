import type { IconProps } from './icons/props.ts'
import { BRAND_MARK_DATA_URI } from './brandMark.ts'

/**
 * Render the brand mark.
 * @param props.size - width in px (default 24; the mark is square).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <image href={BRAND_MARK_DATA_URI} x="0" y="0" width="24" height="24" />
    </svg>
  )
}
