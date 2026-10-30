/**
 * Schichtklar24 product logo "Haken-Uhr" (chosen 2026-10-30; own artwork, inline
 * SVG – no external assets): a clock on a dark blue tile whose hands form a
 * turquoise check mark. Colours are fixed product colours so the mark looks
 * the same on light and dark backgrounds and next to tenant brands.
 */
export function ProductLogo({ size = 32, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : "true"} focusable="false">
      <rect width="512" height="512" rx="112" fill="#0B2545" />
      <circle cx="256" cy="262" r="148" fill="none" stroke="#ffffff" stroke-width="34" />
      {/* hour marks at 12, 3, 6 and 9 o'clock */}
      <circle cx="256" cy="154" r="11" fill="#ffffff" opacity="0.55" />
      <circle cx="364" cy="262" r="11" fill="#ffffff" opacity="0.55" />
      <circle cx="256" cy="370" r="11" fill="#ffffff" opacity="0.55" />
      <circle cx="148" cy="262" r="11" fill="#ffffff" opacity="0.55" />
      {/* check-mark hands with a dark outline so they stand out from the ring */}
      <polyline points="186,266 240,320 392,138" fill="none" stroke="#0B2545" stroke-width="78" stroke-linecap="round" stroke-linejoin="round" />
      <polyline points="186,266 240,320 392,138" fill="none" stroke="#13A89E" stroke-width="48" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
