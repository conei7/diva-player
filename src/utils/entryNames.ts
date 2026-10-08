import type { Song } from '../types/vocadb';

/** The entry's default name is its chosen spelling, independent of UI language. */
export function withDefaultSongName(song: Song): Song {
  const name = song.defaultName?.trim();
  return name && name !== song.name ? { ...song, name } : song;
}
