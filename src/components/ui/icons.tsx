/**
 * Icons (DESIGN_SPEC §4.19). Material Icons / Material Symbols shapes (Apache License 2.0),
 * 24×24 grid, `fill="currentColor"`, always `aria-hidden`. Each icon is its own export so the
 * bundle only carries the ones a screen imports. Navigation pairs: outline = not selected,
 * `…FilledIcon` = selected.
 *
 * The icons the always-loaded frame uses are defined in ./iconsChrome and re-exported here, so
 * screens import every icon from this module (see iconsChrome.tsx for the initial-bundle rule).
 */
import { Svg } from './iconBase';
import { STROKE } from './iconStroke';
import type { IconProps } from './iconBase';

export {
  MenuIcon,
  SearchIcon,
  CloseIcon,
  MoreVertIcon,
  HomeIcon,
  HomeFilledIcon,
  SettingsIcon,
  LanguageIcon,
  KeyboardIcon,
  SpinnerIcon,
  PlaylistIcon,
  PlaylistFilledIcon,
  ClockIcon,
  HistoryIcon,
  HistoryFilledIcon,
  ChorusIcon,
  ChorusFilledIcon,
  PersonStarIcon,
  PersonStarFilledIcon,
  StarIcon,
  StarFilledIcon,
  BarChartIcon,
  ScatterIcon,
  TreemapIcon,
  SparkleIcon,
  MusicNoteIcon,
  MicIcon,
  PersonIcon,
  EyeIcon,
  EyeOffIcon,
  TuneIcon,
  SelectMultipleIcon,
  SelectMultipleFilledIcon,
  CheckIcon,
} from './iconsChrome';
export type { IconProps } from './iconsChrome';

/* ─── Navigation & chrome ───────────────────────────────────────────────── */

export function MoreHorizIcon(props: IconProps) {
  return <Svg {...props}><path d="M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" /></Svg>;
}

export function ArrowBackIcon(props: IconProps) {
  return <Svg {...props}><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" /></Svg>;
}

export function ArrowUpwardIcon(props: IconProps) {
  return <Svg {...props}><path d="m4 12 1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z" /></Svg>;
}

export function ArrowDownwardIcon(props: IconProps) {
  return <Svg {...props}><path d="m20 12-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z" /></Svg>;
}

export function ChevronLeftIcon(props: IconProps) {
  return <Svg {...props}><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></Svg>;
}

export function ChevronRightIcon(props: IconProps) {
  return <Svg {...props}><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" /></Svg>;
}

export function ChevronDownIcon(props: IconProps) {
  return <Svg {...props}><path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z" /></Svg>;
}

export function ChevronUpIcon(props: IconProps) {
  return <Svg {...props}><path d="m12 8-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z" /></Svg>;
}

export function InfoIcon(props: IconProps) {
  return <Svg {...props}><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" /></Svg>;
}

export function WarningIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 5.99 19.53 19H4.47L12 5.99M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z" /></Svg>;
}

export function ErrorIcon(props: IconProps) {
  return <Svg {...props}><path d="M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z" /></Svg>;
}

export function OfflineIcon(props: IconProps) {
  return <Svg {...props}><path d="M24 15c0-2.64-2.05-4.78-4.65-4.96C18.67 6.59 15.64 4 12 4c-1.33 0-2.57.36-3.65.97l1.49 1.49C10.51 6.17 11.23 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 .99-.48 1.85-1.21 2.4l1.41 1.41c1.09-.92 1.8-2.27 1.8-3.81zM4.41 3.86 3 5.27l2.77 2.77h-.42C2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h11.73l2 2 1.41-1.41L4.41 3.86zM6 18c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73l8 8H6z" /></Svg>;
}

export function RefreshIcon(props: IconProps) {
  return <Svg {...props}><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" /></Svg>;
}

export function SyncIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" /></Svg>;
}

/* ─── Playback ──────────────────────────────────────────────────────────── */

export function PlayIcon(props: IconProps) {
  return <Svg {...props}><path d="M8 5v14l11-7z" /></Svg>;
}

export function PauseIcon(props: IconProps) {
  return <Svg {...props}><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></Svg>;
}

export function SkipNextIcon(props: IconProps) {
  return <Svg {...props}><path d="m6 18 8.5-6L6 6v12zM16 6v12h2V6h-2z" /></Svg>;
}

export function SkipPreviousIcon(props: IconProps) {
  return <Svg {...props}><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></Svg>;
}

export function ShuffleIcon(props: IconProps) {
  return <Svg {...props}><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" /></Svg>;
}

export function RepeatIcon(props: IconProps) {
  return <Svg {...props}><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" /></Svg>;
}

export function RepeatOneIcon(props: IconProps) {
  return <Svg {...props}><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z" /></Svg>;
}

export function QueueMusicIcon(props: IconProps) {
  return <Svg {...props}><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" /></Svg>;
}

/** Alias for 「キューに追加」 (same shape as QueueMusicIcon). */
export const QueueIcon = QueueMusicIcon;

export function PlaylistAddIcon(props: IconProps) {
  return <Svg {...props}><path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z" /></Svg>;
}

export function PlaylistPlayIcon(props: IconProps) {
  return <Svg {...props}><path d="M19 9H2v2h17V9zm0-4H2v2h17V5zM2 15h13v-2H2v2zm15-2v6l5-3-5-3z" /></Svg>;
}

/** Volume bars for the row that is playing now. */
export function VolumeBarsIcon(props: IconProps) {
  return <Svg {...props}><path d="M10 20h4V4h-4v16zm-6 0h4v-8H4v8zM16 9v11h4V9h-4z" /></Svg>;
}

export function VolumeUpIcon(props: IconProps) {
  return <Svg {...props}><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" /></Svg>;
}

export function VolumeOffIcon(props: IconProps) {
  return <Svg {...props}><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" /></Svg>;
}

/** 「再生ページを開く」 (the mini player's expand button). */
export function OpenPlayerIcon(props: IconProps) {
  return <Svg {...props}><path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z" /></Svg>;
}

export function TimerIcon(props: IconProps) {
  return <Svg {...props}><path d="M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61 1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42C16.07 4.74 14.12 4 12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9 9-4.03 9-9c0-2.12-.74-4.07-1.97-5.61zM12 20c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" /></Svg>;
}

/* ─── Library & discovery ───────────────────────────────────────────────── */

export function FolderIcon(props: IconProps) {
  return <Svg {...props}><path d="m9.17 6 2 2H20v10H4V6h5.17M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" /></Svg>;
}

export function AlbumIcon(props: IconProps) {
  return <Svg {...props}><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-12.5c-2.49 0-4.5 2.01-4.5 4.5s2.01 4.5 4.5 4.5 4.5-2.01 4.5-4.5-2.01-4.5-4.5-4.5zm0 5.5c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z" /></Svg>;
}

/* ─── Actions ───────────────────────────────────────────────────────────── */

export function ShareIcon(props: IconProps) {
  return <Svg {...props}><path d="M14 5.5 20.5 12 14 18.5v-3.9c-4.6-.2-8 1.2-10.5 4.4.8-5 3.9-8.6 10.5-9.5z" {...STROKE} strokeWidth={1.8} /></Svg>;
}

export function LinkIcon(props: IconProps) {
  return <Svg {...props}><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" /></Svg>;
}

export function CopyIcon(props: IconProps) {
  return <Svg {...props}><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" /></Svg>;
}

export function OpenInNewIcon(props: IconProps) {
  return <Svg {...props}><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" /></Svg>;
}

/** Not used for 「表示しない」 (that is EyeOffIcon). */
export function ThumbDownIcon(props: IconProps) {
  return <Svg {...props}><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm0 12-4.34 4.34L12 14H3v-2l3-7h9v10zm4-12h4v12h-4z" /></Svg>;
}

export function SortIcon(props: IconProps) {
  return <Svg {...props}><path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z" /></Svg>;
}

export function GridIcon(props: IconProps) {
  return <Svg {...props}><path d="M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z" /></Svg>;
}

export function ListIcon(props: IconProps) {
  return <Svg {...props}><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" /></Svg>;
}

export function AddIcon(props: IconProps) {
  return <Svg {...props}><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></Svg>;
}

export function EditIcon(props: IconProps) {
  return <Svg {...props}><path d="m14.06 9.02.92.92L5.92 19H5v-.92l9.06-9.06M17.66 3c-.25 0-.51.1-.7.29l-1.83 1.83 3.75 3.75 1.83-1.83c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.2-.2-.45-.29-.71-.29zm-3.6 3.19L3 17.25V21h3.75L17.81 9.94l-3.75-3.75z" /></Svg>;
}

export function TrashIcon(props: IconProps) {
  return <Svg {...props}><path d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z" /></Svg>;
}

export function ImageIcon(props: IconProps) {
  return <Svg {...props}><path d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-4.86 8.86-3 3.87L9 13.14 6 17h12l-3.86-5.14z" /></Svg>;
}

export function MoveToTopIcon(props: IconProps) {
  return <Svg {...props}><path d="M8 11h3v10h2V11h3l-4-4-4 4zM4 3v2h16V3H4z" /></Svg>;
}

export function MoveToBottomIcon(props: IconProps) {
  return <Svg {...props}><path d="M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z" /></Svg>;
}

export function CheckCircleIcon(props: IconProps) {
  return <Svg {...props}><path d="M16.59 7.58 10 14.17l-3.59-3.58L5 12l5 5 8-8zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z" /></Svg>;
}

export function CheckBoxIcon(props: IconProps) {
  return <Svg {...props}><path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm-9 14-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" /></Svg>;
}

export function CheckBoxOutlineIcon(props: IconProps) {
  return <Svg {...props}><path d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" /></Svg>;
}

export function DragHandleIcon(props: IconProps) {
  return <Svg {...props}><path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" /></Svg>;
}

export function DownloadIcon(props: IconProps) {
  return <Svg {...props}><path d="M18 15v3H6v-3H4v3c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-3h-2zm-1-4-1.41-1.41L13 12.17V4h-2v8.17L8.41 9.59 7 11l5 5 5-5z" /></Svg>;
}

export function UploadIcon(props: IconProps) {
  return <Svg {...props}><path d="M18 15v3H6v-3H4v3c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-3h-2zM7 9l1.41 1.41L11 7.83V16h2V7.83l2.59 2.58L17 9l-5-5-5 5z" /></Svg>;
}
