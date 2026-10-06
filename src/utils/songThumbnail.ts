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
