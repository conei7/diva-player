/**
 * The DIVA Player mark: a flat brand-colored tile with a 「D」 whose counter is a play triangle.
 * One flat color (no gradient), so it stays crisp at 16px (favicon) and 28px (top bar), and it follows
 * the accent color chosen in Settings. `muted` greys it out (hidden mode). public/favicon.svg draws the
 * same paths with the default mint.
 */
export const BRAND_MARK_GLYPH =
  'M10 7.5h5a8.5 8.5 0 0 1 0 17h-5A1.5 1.5 0 0 1 8.5 23V9A1.5 1.5 0 0 1 10 7.5ZM13.25 11.6v8.8a.6.6 0 0 0 .9.52l7.1-4.4a.6.6 0 0 0 0-1.04l-7.1-4.4a.6.6 0 0 0-.9.52Z';

export default function BrandMark({ size = 28, muted = false }: { size?: number; muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="shrink-0">
      <rect width="32" height="32" rx="8" fill={muted ? 'var(--color-yt-tonal-solid-hover)' : 'var(--color-brand)'} />
      {/* The page color on the accent, like the play buttons (bg-brand text-yt-bg): the accent is light
          in the dark theme and darkened for contrast in the light one (accessibleAccentColor). */}
      <path fillRule="evenodd" d={BRAND_MARK_GLYPH} fill={muted ? 'var(--color-yt-text-secondary)' : 'var(--color-yt-bg)'} />
    </svg>
  );
}
