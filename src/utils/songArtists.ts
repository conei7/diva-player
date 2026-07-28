import type { ArtistType, Song } from '../types/vocadb';

export interface SongProducerEntry {
  id: number;
  name: string;
  artistType: ArtistType;
  href: string | null;
}

export function getSongProducerEntries(song: Pick<Song, 'artists' | 'artistString'>): SongProducerEntry[] {
  return (song.artists ?? [])
    .filter(artist => artist.categories?.includes('Producer'))
    .map((artist) => {
      const name = artist.name || artist.artist?.name || '';
      const id = artist.artist.id;
      const href = id
        ? `/?artistId=${id}&artistName=${encodeURIComponent(name)}`
        : name
          ? `/?q=${encodeURIComponent(name)}`
          : null;
      return {
        id,
        name,
        artistType: artist.artist.artistType,
        href,
      };
    })
    .filter((producer): producer is SongProducerEntry => producer.name.length > 0);
}
