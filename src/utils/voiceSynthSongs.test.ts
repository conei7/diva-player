import { describe, expect, it } from 'vitest';
import type { ArtistForSong, Song } from '../types/vocadb';
import { filterVoiceSynthSongs } from './voiceSynthSongs';

function song(id: number, artistType: ArtistForSong['artist']['artistType']): Song {
  return {
    id,
    name: `song-${id}`,
    defaultName: `song-${id}`,
    defaultNameLanguage: 'Unspecified',
    artistString: 'artist',
    createDate: '2026-01-01',
    favoritedTimes: 0,
    lengthSeconds: 180,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    artists: [{
      artist: { artistType } as ArtistForSong['artist'],
      categories: 'Vocalist',
    } as ArtistForSong],
  };
}

describe('filterVoiceSynthSongs', () => {
  it('keeps all voice-synth artist types accepted by discovery APIs', () => {
    const types: ArtistForSong['artist']['artistType'][] = [
      'Vocaloid',
      'UTAU',
      'CeVIO',
      'SynthesizerV',
      'NEUTRINO',
      'VoiSona',
      'Voiceroid',
      'OtherVoiceSynthesizer',
      'NewType',
    ];
    expect(filterVoiceSynthSongs(types.map((type, index) => song(index + 1, type)))).toHaveLength(types.length);
  });

  it('removes human vocalist records', () => {
    expect(filterVoiceSynthSongs([
      song(1, 'Voiceroid'),
      song(2, 'OtherVocalist'),
    ]).map(item => item.id)).toEqual([1]);
  });
});
