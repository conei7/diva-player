/**
 * Icons the shared set (components/ui/icons.tsx) doesn't have. Material Icons shapes
 * (Apache License 2.0), 24×24, `fill="currentColor"`, aria-hidden. Paths only: the sound map
 * test checks that the map has no <line> elements.
 */
import type { ReactNode } from 'react';
import type { IconProps } from '../ui/icons';

function Svg({ size = 24, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className ? `shrink-0 ${className}` : 'shrink-0'}
    >
      {children}
    </svg>
  );
}

/** − (zoom out). */
export function RemoveIcon(props: IconProps) {
  return <Svg {...props}><path d="M19 13H5v-2h14v2z" /></Svg>;
}

/** ⌖ (go to the starting song). */
export function MyLocationIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" />
    </Svg>
  );
}

/** ↶ (previous starting song). */
export function UndoIcon(props: IconProps) {
  return <Svg {...props}><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" /></Svg>;
}

/** ◎ (explore around this song). */
export function ExploreNearbyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19.07 4.93l-1.41 1.41A7.95 7.95 0 0 1 20 12c0 4.42-3.58 8-8 8s-8-3.58-8-8c0-4.08 3.05-7.44 7-7.93v2.02C8.16 6.57 6 9.03 6 12c0 3.31 2.69 6 6 6s6-2.69 6-6c0-1.66-.67-3.16-1.76-4.24l-1.41 1.41C15.55 9.9 16 10.9 16 12c0 2.21-1.79 4-4 4s-4-1.79-4-4c0-1.86 1.28-3.41 3-3.86v2.14c-.6.35-1 .98-1 1.72 0 1.1.9 2 2 2s2-.9 2-2c0-.74-.4-1.38-1-1.72V2h-1C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10c0-2.76-1.12-5.26-2.93-7.07z" />
    </Svg>
  );
}

/** ⇄ (swap X and Y). */
export function SwapIcon(props: IconProps) {
  return <Svg {...props}><path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z" /></Svg>;
}
