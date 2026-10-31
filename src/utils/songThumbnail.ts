import type { Song } from '../types/vocadb';

type SongThumbnailSources = Pick<Song, 'thumbUrl' | 'pvs'>;

/** Return distinct thumbnail URLs, preferring the song-level image and then active PVs. */
export function getSongThumbnailCandidates(song: SongThumbnailSources): string[] {
  const candidates: string[] = [];
  const disabledPvThumbnails = new Set(
    (song.pvs ?? [])
      .filter(pv => pv.disabled)
      .map(pv => pv.thumbUrl?.trim())
      .filter((url): url is string => Boolean(url)),
  );

  const add = (rawUrl?: string) => {
    const url = rawUrl?.trim();
    if (url && !disabledPvThumbnails.has(url) && !candidates.includes(url)) {
      candidates.push(url);
    }
  };

  add(song.thumbUrl);

  for (const pv of song.pvs ?? []) {
    if (!pv.disabled) add(pv.thumbUrl);
  }

  for (const pv of song.pvs ?? []) {
    if (!pv.disabled && pv.service === 'Youtube' && /^[\w-]{11}$/.test(pv.pvId)) {
      const videoId = encodeURIComponent(pv.pvId);
      add(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`);
      add(`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`);
    }
  }

  return candidates;
}

const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/;

/**
 * Candidates for a 16:9 frame: the YouTube `mqdefault` (16:9, no letterbox) and
 * `hqdefault` of active YouTube PVs first (official PVs before reuploads), then
 * everything from getSongThumbnailCandidates(), without duplicates.
 */
export function getWideSongThumbnailCandidates(song: SongThumbnailSources): string[] {
  const candidates: string[] = [];
  const add = (url: string) => {
    if (!candidates.includes(url)) candidates.push(url);
  };

  const youtubePvs = (song.pvs ?? [])
    .filter(pv => !pv.disabled && pv.service === 'Youtube' && YOUTUBE_VIDEO_ID.test(pv.pvId))
    .sort((a, b) => Number(b.pvType === 'Original') - Number(a.pvType === 'Original'));

  for (const pv of youtubePvs) {
    const videoId = encodeURIComponent(pv.pvId);
    add(`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`);
    add(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`);
  }

  for (const url of getSongThumbnailCandidates(song)) add(url);
  return candidates;
}

/**
 * Candidates for a square frame (object-cover crop): YouTube `mqdefault` (16:9 without bars) first,
 * then the song and PV images, and `hqdefault` last (its 4:3 letterbox bars would show in a square).
 */
export function getSquareSongThumbnailCandidates(song: SongThumbnailSources): string[] {
  const wide = getWideSongThumbnailCandidates(song);
  const letterboxed = wide.filter(url => /\/hqdefault\.jpg$/.test(url));
  return [...wide.filter(url => !letterboxed.includes(url)), ...letterboxed];
}
