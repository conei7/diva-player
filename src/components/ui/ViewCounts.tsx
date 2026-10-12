import type { CSSProperties, ReactNode } from 'react';
import type { PVService, Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { getPVBadgeStyle, isUnofficialOnly } from '../../utils/pvBadge';
import { formatCompactCount, formatViewCount } from '../../utils/songMeta';
import { cx } from './overlay';
import { finiteViews, hasActivePV } from './songMetaParts';

/*
 * Per-service view counts as colored badges: YouTube red, Niconico blue (SoundCloud orange,
 * Bilibili light blue without a count). A service whose videos are all re-uploads gets the dark
 * variant of its color, so songs without an official video stand out in every list.
 */

const BADGE_CLASS =
  'inline-flex h-4 shrink-0 items-center gap-1 rounded-[4px] px-1 text-[11px] leading-none font-bold tabular-nums';

function YouTubeGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true" className="shrink-0">
      <path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4a2.5 2.5 0 0 0-1.8 1.8A26 26 0 0 0 2 12c0 1.6.1 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8c1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8c.3-1.6.4-3.2.4-4.8s-.1-3.2-.4-4.8ZM10 15V9l5.2 3L10 15Z" />
    </svg>
  );
}

function NiconicoGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true" className="shrink-0">
      <path d="M8.3 2.3a1 1 0 0 1 1.4.1L12 5l2.3-2.6a1 1 0 1 1 1.5 1.3L14.6 5H19a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-1.4l.8 1.4a1 1 0 0 1-1.7 1L15.3 20H8.7l-1.4 2.4a1 1 0 0 1-1.7-1l.8-1.4H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h4.4L8.2 3.7a1 1 0 0 1 .1-1.4Z" />
    </svg>
  );
}

function badgeStyle(service: PVService, unofficial: boolean): CSSProperties {
  const palette = getPVBadgeStyle(service, unofficial ? 'Reprint' : 'Original');
  return { background: palette.background, color: palette.color, border: palette.border };
}

export interface ViewCountsProps {
  song: Song;
  className?: string;
}

/**
 * 「▶4470万 N1378万」: one badge per service that has a video or a count. A video without a known
 * count shows the badge without a number; SoundCloud / Bilibili show 「SC」「Bili」.
 */
export default function ViewCounts({ song, className }: ViewCountsProps) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const pvs = song.pvs ?? [];
  const badges: ReactNode[] = [];

  const counted: { service: 'Youtube' | 'NicoNicoDouga'; count: number; label: string; glyph: ReactNode }[] = [
    { service: 'Youtube', count: finiteViews(song.youtubeViews), label: 'YouTube', glyph: <YouTubeGlyph /> },
    {
      service: 'NicoNicoDouga',
      count: finiteViews(song.nicoViews),
      label: language === 'en' ? 'Niconico' : 'ニコニコ',
      glyph: <NiconicoGlyph />,
    },
  ];
  for (const item of counted) {
    if (item.count === 0 && !hasActivePV(song, item.service)) continue;
    const unofficial = isUnofficialOnly(pvs, item.service);
    const count = item.count > 0 ? formatCompactCount(item.count, language) : null;
    const description = [
      item.label,
      item.count > 0 ? formatViewCount(item.count, language) : t('再生数不明'),
      unofficial ? t('転載のみ') : null,
    ].filter(Boolean).join(' ');
    badges.push(
      <span
        key={item.service}
        className={BADGE_CLASS}
        style={badgeStyle(item.service, unofficial)}
        title={description}
      >
        {item.glyph}
        <span className="sr-only">{description}</span>
        {count && <span aria-hidden="true">{count}</span>}
      </span>,
    );
  }

  for (const [service, text] of [['SoundCloud', 'SC'], ['Bilibili', 'Bili']] as const) {
    if (!hasActivePV(song, service)) continue;
    badges.push(
      <span key={service} className={BADGE_CLASS} style={badgeStyle(service, isUnofficialOnly(pvs, service))} title={service}>
        {text}
      </span>,
    );
  }

  if (badges.length === 0) return null;
  return <span className={cx('inline-flex items-center gap-1 align-[-3px]', className)}>{badges}</span>;
}
