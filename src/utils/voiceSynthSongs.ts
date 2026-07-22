import type { Song } from '../types/vocadb';
import { isVoiceSynthArtistType } from '../config/voiceSynthTypes';

/** Excludes the occasional human-vocal / non-vocaloid record registered in VocaDB. */
export function isVoiceSynthSong(song: Song): boolean {
  const vocalists = (song.artists ?? []).filter(artist => artist.categories?.includes('Vocalist'));
  return vocalists.some(artist => isVoiceSynthArtistType(artist.artist?.artistType));
}

export function filterVoiceSynthSongs(songs: Song[]): Song[] {
  return songs.filter(isVoiceSynthSong);
}
