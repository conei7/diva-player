import { describe, expect, it } from 'vitest';
import type { ArtistForSong, Song } from '../types/vocadb';
import { filterVoiceSynthSongs } from './voiceSynthSongs';

type ArtistType = NonNullable<ArtistForSong['artist']>['artistType'];

function song(id: number, artistType: ArtistType, isSupport = false): Song {
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
      artist: { artistType } as NonNullable<ArtistForSong['artist']>,
      categories: 'Vocalist',
      isSupport,
    } as ArtistForSong],
  };
}

describe('filterVoiceSynthSongs', () => {
  it('keeps all voice-synth artist types accepted by discovery APIs', () => {
    const types: ArtistType[] = [
      'Vocaloid',
      'UTAU',
      'CeVIO',
      'SynthesizerV',
      'NEUTRINO',
      'VoiSona',
      'Voiceroid',
      'OtherVoiceSynthesizer',
      'NewType',
      'ACEVirtualSinger',
      'VOICEVOX',
      'AIVOICE',
    ];
    expect(filterVoiceSynthSongs(types.map((type, index) => song(index + 1, type)))).toHaveLength(types.length);
  });

  it('removes human vocalist records', () => {
    expect(filterVoiceSynthSongs([
      song(1, 'Voiceroid'),
      song(2, 'OtherVocalist'),
    ]).map(item => item.id)).toEqual([1]);
  });

  it('does not treat a support-only voice synthesizer as the main vocalist', () => {
    const manuallyExcludedHumanOriginal = song(933455, 'OtherVocalist');
    manuallyExcludedHumanOriginal.artists?.push({
      artist: { artistType: 'OtherVoiceSynthesizer' } as NonNullable<ArtistForSong['artist']>,
      categories: 'Vocalist',
      isSupport: true,
    } as ArtistForSong);
    expect(filterVoiceSynthSongs([
      manuallyExcludedHumanOriginal,
      song(566566, 'Vocaloid'),
    ]).map(item => item.id)).toEqual([566566]);
  });
});
