/**
 * Stundenwerk product logo (own artwork, inline SVG – no external assets).
 * A rounded tile with a clock whose open ring ends in an accent dot:
 * "time, done properly". Colours are fixed product colours so the mark
 * looks the same on light and dark backgrounds and next to tenant brands.
 */
import { useId } from "preact/hooks";

export function ProductLogo({ size = 32, title }: { size?: number; title?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const grad = `swg-${id}`;
  const shine = `sws-${id}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : "true"} focusable="false">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#6366f1" />
          <stop offset="1" stop-color="#3730a3" />
        </linearGradient>
        <linearGradient id={shine} x1="16" y1="0" x2="16" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".22" />
          <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${grad})`} />
      <rect width="32" height="16" rx="9" fill={`url(#${shine})`} />
      {/* open clock ring: from 12 o'clock clockwise to about 10 o'clock */}
      <path d="M16 7.2a8.8 8.8 0 1 1-7.62 4.4" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" />
      <path d="M16 11.2V16l3.4 2.1" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="11.6" cy="8.4" r="1.9" fill="#22d3ee" />
    </svg>
  );
}
