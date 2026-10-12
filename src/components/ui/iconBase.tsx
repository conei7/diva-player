/**
 * The shared base of the icons (DESIGN_SPEC §4.19): the 24×24 svg wrapper (the stroke style is in
 * ./iconStroke). Screens import icons from ./icons; the always-loaded frame imports from ./iconsChrome.
 */
import type { ReactNode } from 'react';

export interface IconProps {
  /** Width and height in px. Default 24 (use 20 in small places). */
  size?: number;
  className?: string;
}

export function Svg({ size = 24, className, children }: IconProps & { children: ReactNode }) {
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
