/**
 * Labels for a song's videos (the video pill on the song page, the 「動画」 list of the description,
 * the song details dialog): 「YouTube（公式）」 / 'YouTube (official)' (DESIGN_SPEC §7.4).
 */
import type { AppLanguage } from '../../stores/languageStore';
import { pvKindLabel, serviceLabel } from '../../utils/songMeta';
import { formatCalendarDate } from './watchFormat';

export interface VideoLabelSource {
  service: string;
  pvType: string;
  name?: string | null;
  publishDate?: string | null;
}

const SHORT_NAME_LENGTH = 24;

/** The video name cut to 24 characters (…). */
export function shortVideoName(name: string): string {
  const trimmed = name.trim();
  const characters = Array.from(trimmed);
  return characters.length > SHORT_NAME_LENGTH ? `${characters.slice(0, SHORT_NAME_LENGTH - 1).join('')}…` : trimmed;
}

/**
 * 「YouTube（公式）」 / 'YouTube (official)'. The kind alone stays capitalized (pvKindLabel: 'Official'),
 * but after the service name it is lower case in English (sentence case, §2.1-11).
 */
export function videoSourceLabel(
  video: Pick<VideoLabelSource, 'service' | 'pvType'>,
  language: AppLanguage,
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  const kind = pvKindLabel(video.pvType, language);
  return t('{service}（{kind}）', {
    service: serviceLabel(video.service, language),
    kind: language === 'en' ? kind.charAt(0).toLowerCase() + kind.slice(1) : kind,
  });
}

/**
 * Adds 「 · {short video name}」 when another video in `videos` has the same service and kind, so that two
 * official YouTube videos can be told apart; when their names are the same too, the release date follows
 * (「YouTube · きゅうくらりん · 2021年9月4日」). Otherwise the label is returned as it is.
 */
export function withVideoName(
  label: string,
  video: VideoLabelSource,
  videos: readonly VideoLabelSource[],
  language: AppLanguage,
): string {
  const name = video.name?.trim();
  if (!name) return label;
  const sameKind = videos.filter(item => item.service === video.service && item.pvType === video.pvType);
  if (sameKind.length < 2) return label;
  const short = shortVideoName(name);
  const sameName = sameKind.some(item => item !== video && shortVideoName(item.name ?? '') === short);
  const date = sameName ? formatCalendarDate(video.publishDate ?? undefined, language) : null;
  return date ? `${label} · ${short} · ${date}` : `${label} · ${short}`;
}
