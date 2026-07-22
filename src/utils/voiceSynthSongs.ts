import type { Song } from '../types/vocadb';

const VOICE_SYNTH_TYPES = new Set([
  'Vocaloid', 'UTAU', 'CeVIO', 'SynthesizerV', 'NEUTRINO', 'VoiSona',
  'Voiceroid', 'OtherVoiceSynthesizer', 'NewType',
  'ACEVirtualSinger', 'VOICEVOX', 'AIVOICE',
]);

/** Excludes the occasional human-vocal / non-vocaloid record registered in VocaDB. */
export function isVoiceSynthSong(song: Song): boolean {
  const vocalists = (song.artists ?? []).filter(artist => artist.categories?.includes('Vocalist'));
  return vocalists.some(artist => VOICE_SYNTH_TYPES.has(artist.artist?.artistType ?? ''));
}

export function filterVoiceSynthSongs(songs: Song[]): Song[] {
  return songs.filter(isVoiceSynthSong);
}
