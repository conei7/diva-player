import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { getProducerNames, songTypeLabel } from '../../utils/songMeta';

export interface SongProducerLink {
  id?: number;
  name: string;
}

/** Producers credited on the song (with their VocaDB id when known), falling back to artistString. */
export function getSongProducerLinks(song: Song): SongProducerLink[] {
  const seen = new Set<string>();
  const credited = (song.artists ?? [])
    .filter(artist => artist.categories?.includes('Producer'))
    .flatMap(artist => {
      const name = (artist.name || artist.artist?.name || '').trim();
      if (!name || seen.has(name)) return [];
      seen.add(name);
      return [{ id: artist.artist?.id, name }];
    });
  if (credited.length > 0) return credited;
  return getProducerNames(song).map(name => ({ name }));
}

/** Self-cover, or the song type when it is not an original (one gray tag at most). */
export function useSongTypeTagLabel(song: Song): string | null {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  if (song.isSelfCover) return t('セルフカバー');
  if (song.songType && song.songType !== 'Original' && song.songType !== 'Unspecified') {
    return songTypeLabel(song.songType, language);
  }
  return null;
}
