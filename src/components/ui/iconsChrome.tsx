/**
 * The icons of the always-loaded frame (top bar, guide, bottom nav, search box, Menu, Button).
 * They live in their own module so the initial JavaScript carries only these (DESIGN_SPEC §1-12);
 * ./icons re-exports them with every other icon. Screens import from ./icons. A module that is
 * part of the initial JavaScript (layout, Menu, Button…) imports from here: importing ./icons there
 * would bring every icon back into the initial bundle (scripts/test-performance-budget.mjs).
 */
import { Svg } from './iconBase';
import { STROKE } from './iconStroke';
import type { IconProps } from './iconBase';

export type { IconProps } from './iconBase';

/* ─── Navigation & chrome ───────────────────────────────────────────────── */

export function MenuIcon(props: IconProps) {
  return <Svg {...props}><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" /></Svg>;
}

export function SearchIcon(props: IconProps) {
  return <Svg {...props}><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" /></Svg>;
}

export function CloseIcon(props: IconProps) {
  return <Svg {...props}><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></Svg>;
}

export function MoreVertIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" /></Svg>;
}

export function HomeIcon(props: IconProps) {
  return <Svg {...props}><path d="m12 5.69 5 4.5V18h-2v-6H9v6H7v-7.81l5-4.5M12 3 2 12h3v8h6v-6h2v6h6v-8h3L12 3z" /></Svg>;
}

export function HomeFilledIcon(props: IconProps) {
  return <Svg {...props}><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></Svg>;
}

export function SettingsIcon(props: IconProps) {
  return <Svg {...props}><path d="M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.09-.16-.26-.25-.44-.25-.06 0-.12.01-.17.03l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.06-.02-.12-.03-.18-.03-.17 0-.34.09-.43.25l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.09.16.26.25.44.25.06 0 .12-.01.17-.03l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.06.02.12.03.18.03.17 0 .34-.09.43-.25l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zm-1.98-1.71c.04.31.05.52.05.73 0 .21-.02.43-.05.73l-.14 1.13.89.7 1.08.84-.7 1.21-1.27-.51-1.04-.42-.9.68c-.43.32-.84.56-1.25.73l-1.06.43-.16 1.13-.2 1.35h-1.4l-.19-1.35-.16-1.13-1.06-.43c-.43-.18-.83-.41-1.23-.71l-.91-.7-1.06.43-1.27.51-.7-1.21 1.08-.84.89-.7-.14-1.13c-.03-.31-.05-.54-.05-.74s.02-.43.05-.73l.14-1.13-.89-.7-1.08-.84.7-1.21 1.27.51 1.04.42.9-.68c.43-.32.84-.56 1.25-.73l1.06-.43.16-1.13.2-1.35h1.39l.19 1.35.16 1.13 1.06.43c.43.18.83.41 1.23.71l.91.7 1.06-.43 1.27-.51.7 1.21-1.07.85-.89.7.14 1.13zM12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" /></Svg>;
}

export function LanguageIcon(props: IconProps) {
  return <Svg {...props}><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z" /></Svg>;
}

export function KeyboardIcon(props: IconProps) {
  return <Svg {...props}><path d="M20 7v10H4V7h16m0-2H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2zm0 3h2v2h-2zM8 8h2v2H8zm0 3h2v2H8zm-3 0h2v2H5zm0-3h2v2H5zm3 6h8v2H8zm6-3h2v2h-2zm0-3h2v2h-2zm3 3h2v2h-2zm0-3h2v2h-2z" /></Svg>;
}

/** Spinning progress arc (the rotation comes with it). */
export function SpinnerIcon({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className={className ? `shrink-0 animate-spin ${className}` : 'shrink-0 animate-spin'}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/* ─── Playback ──────────────────────────────────────────────────────────── */

/** Playlist (guide, thumbnail badge, empty cover): lines and an outlined play triangle. */
export function PlaylistIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h9v2H3z" />
      <path d="m16.5 13.6 4.6 2.9-4.6 2.9z" {...STROKE} strokeWidth={1.7} />
    </Svg>
  );
}

export function PlaylistFilledIcon(props: IconProps) {
  return <Svg {...props}><path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h9v2H3zm12.6-.2v7.4l6-3.7z" /></Svg>;
}

/* ─── Library & discovery ───────────────────────────────────────────────── */

/** 後で聴く (clock). */
export function ClockIcon(props: IconProps) {
  return <Svg {...props}><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" /></Svg>;
}

const HISTORY_RING = 'M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z';

export function HistoryIcon(props: IconProps) {
  return <Svg {...props}><path d={`${HISTORY_RING}m-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z`} /></Svg>;
}

export function HistoryFilledIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d={HISTORY_RING} />
      <path fillRule="evenodd" d="M13 4.6a7.4 7.4 0 1 0 0 14.8 7.4 7.4 0 1 0 0-14.8zM12 8v5l4.28 2.54.72-1.21-3.5-2.08V8z" />
    </Svg>
  );
}

/** サビ発掘 (waveform). The filled variant is the bolder weight. */
export function ChorusIcon(props: IconProps) {
  return <Svg {...props}><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" {...STROKE} /></Svg>;
}

export function ChorusFilledIcon(props: IconProps) {
  return <Svg {...props}><path d="M4 9.5v5M8 6.5v11M12 3.5v17M16 6.5v11M20 9.5v5" {...STROKE} strokeWidth={3} /></Svg>;
}

const STAR_BADGE = 'm18 12.4 1.12 3.06 3.26.12-2.57 2.01.89 3.13L18 18.9l-2.7 1.82.89-3.13-2.57-2.01 3.26-.12z';

/** お気に入りP (person with a star). */
export function PersonStarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="7.5" r="3.5" {...STROKE} />
      <path d="M2.5 20v-1.2c0-2.7 3.9-4.3 6.5-4.3 1.1 0 2.3.2 3.4.6M2.5 20H11" {...STROKE} />
      <path d={STAR_BADGE} />
    </Svg>
  );
}

export function PersonStarFilledIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="7.5" r="4.5" />
      <path d="M1.5 21v-2.2c0-3.3 4.6-5.3 7.5-5.3 1.4 0 2.9.3 4.2.8L12.4 16.6l-.4 4.4z" />
      <path d={STAR_BADGE} />
    </Svg>
  );
}

export function StarIcon(props: IconProps) {
  return <Svg {...props}><path d="m22 9.24-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z" /></Svg>;
}

export function StarFilledIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></Svg>;
}

/** レポート. */
export function BarChartIcon(props: IconProps) {
  return <Svg {...props}><path d="M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z" /></Svg>;
}

/** 曲調マップ. */
export function ScatterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="16.5" r="2.75" {...STROKE} />
      <circle cx="10.5" cy="7.5" r="2.75" {...STROKE} />
      <circle cx="17.25" cy="13" r="2.75" {...STROKE} />
    </Svg>
  );
}

/** 知ってる度. */
export function TreemapIcon(props: IconProps) {
  return <Svg {...props}><path d="M19 5v2h-4V5h4M9 5v6H5V5h4m10 8v6h-4v-6h4M9 17v2H5v-2h4M21 3h-8v6h8V3zM11 3H3v10h8V3zm10 8h-8v10h8V11zm-10 4H3v6h8v-6z" /></Svg>;
}

/** 発掘ミックス. */
export function SparkleIcon(props: IconProps) {
  return <Svg {...props}><path d="m19 9 1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z" /></Svg>;
}

export function MusicNoteIcon(props: IconProps) {
  return <Svg {...props}><path d="m12 3 .01 10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4.01 4S14 19.21 14 17V7h4V3h-6zm-1.99 16c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" /></Svg>;
}

export function MicIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1.2-9.1c0-.66.54-1.2 1.2-1.2.66 0 1.2.54 1.2 1.2l-.01 6.2c0 .66-.53 1.2-1.19 1.2-.66 0-1.2-.54-1.2-1.2V4.9zm6.5 6.1c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" /></Svg>;
}

export function PersonIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 5.9c1.16 0 2.1.94 2.1 2.1s-.94 2.1-2.1 2.1S9.9 9.16 9.9 8s.94-2.1 2.1-2.1m0 9c2.97 0 6.1 1.46 6.1 2.1v1.1H5.9V17c0-.64 3.13-2.1 6.1-2.1M12 4C9.79 4 8 5.79 8 8s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 9c-2.67 0-8 1.34-8 4v3h16v-3c0-2.66-5.33-4-8-4z" /></Svg>;
}

/* ─── Actions ───────────────────────────────────────────────────────────── */

/** 再表示 (Material "visibility", outlined). The counterpart of EyeOffIcon. */
export function EyeIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 6c3.79 0 7.17 2.13 8.82 5.5C19.17 14.87 15.79 17 12 17s-7.17-2.13-8.82-5.5C4.83 8.13 8.21 6 12 6m0-2C7 4 2.73 7.11 1 11.5 2.73 15.89 7 19 12 19s9.27-3.11 11-7.5C21.27 7.11 17 4 12 4zm0 5c1.38 0 2.5 1.12 2.5 2.5S13.38 14 12 14s-2.5-1.12-2.5-2.5S10.62 9 12 9m0-2c-2.48 0-4.5 2.02-4.5 4.5S9.52 16 12 16s4.5-2.02 4.5-4.5S14.48 7 12 7z" /></Svg>;
}

/** 表示しない. */
export function EyeOffIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 6c3.79 0 7.17 2.13 8.82 5.5-.59 1.22-1.42 2.27-2.41 3.12l1.41 1.41c1.39-1.23 2.49-2.77 3.18-4.53C21.27 7.11 17 4 12 4c-1.27 0-2.49.2-3.64.57l1.65 1.65C10.66 6.09 11.32 6 12 6zm-1.07 1.14L13 9.21c.57.25 1.03.71 1.28 1.28l2.07 2.07c.08-.34.14-.7.14-1.07C16.5 9.01 14.48 7 12 7c-.37 0-.72.05-1.07.14zM2.01 3.87l2.68 2.68C3.06 7.83 1.77 9.53 1 11.5 2.73 15.89 7 19 12 19c1.52 0 2.98-.29 4.32-.82l3.42 3.42 1.41-1.41L3.42 2.45 2.01 3.87zm7.5 7.5 2.61 2.61c-.04.01-.08.02-.12.02-1.38 0-2.5-1.12-2.5-2.5 0-.05.01-.08.01-.13zm-3.4-3.4 1.75 1.75c-.23.55-.36 1.15-.36 1.78 0 2.48 2.02 4.5 4.5 4.5.63 0 1.23-.13 1.77-.36l.98.98c-.88.24-1.8.38-2.75.38-3.79 0-7.17-2.13-8.82-5.5.7-1.43 1.72-2.61 2.93-3.53z" /></Svg>;
}

/** 詳細検索. */
export function TuneIcon(props: IconProps) {
  return <Svg {...props}><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" /></Svg>;
}

/** Top bar multi-select toggle (Material "library_add_check", outlined). */
export function SelectMultipleIcon(props: IconProps) {
  return <Svg {...props}><path d="M20 4v12H8V4h12m0-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7.53 12L9 10.5l1.4-1.41 2.07 2.08L17.6 6 19 7.41 12.47 14zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z" /></Svg>;
}

/** SelectMultipleIcon while selection mode is on (filled). */
export function SelectMultipleFilledIcon(props: IconProps) {
  return <Svg {...props}><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7.53 12L9 10.5l1.4-1.41 2.07 2.08L17.6 6 19 7.41 12.47 14zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z" /></Svg>;
}

export function CheckIcon(props: IconProps) {
  return <Svg {...props}><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></Svg>;
}
