import type { Song } from '../types/vocadb';

const VOICE_SYNTH_TYPES = new Set([
  'Vocaloid', 'UTAU', 'CeVIO', 'SynthesizerV', 'NEUTRINO', 'VoiSona',
  'Voiceroid', 'OtherVoiceSynthesizer', 'NewType',
]);

/** Excludes the occasional human-vocal / non-vocaloid record registered in VocaDB. */
export function isVoiceSynthSong(song: Song): boolean {
  const vocalists = (song.artists ?? []).filter(artist => artist.categories?.includes('Vocalist'));
  if (vocalists.some(artist => VOICE_SYNTH_TYPES.has(artist.artist?.artistType ?? ''))) return true;

  const tagNames = (song.tags ?? []).map(tag => tag.tag.name.toLowerCase());
  return tagNames.some(name => /vocaloid|ボーカロイド|初音ミク|鏡音|巡音|utau|cevio|synthesizerv|neutrino|voisona/.test(name));
}

export function filterVoiceSynthSongs(songs: Song[]): Song[] {
  return songs.filter(isVoiceSynthSong);
}
