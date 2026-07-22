import { describe, expect, it } from 'vitest';
import {
  VOICE_SYNTH_ARTIST_TYPES,
  VOICE_SYNTH_TYPE_LABELS,
  VOCALIST_SEARCH_ARTIST_TYPES,
  isVoiceSynthArtistType,
} from './voiceSynthTypes';

describe('voice-synth artist type contract', () => {
  it('contains no duplicate types and provides a label for every filter type', () => {
    expect(new Set(VOICE_SYNTH_ARTIST_TYPES).size).toBe(VOICE_SYNTH_ARTIST_TYPES.length);
    expect(Object.keys(VOICE_SYNTH_TYPE_LABELS).sort()).toEqual([...VOICE_SYNTH_ARTIST_TYPES].sort());
  });

  it.each(['ACEVirtualSinger', 'VOICEVOX', 'AIVOICE'] as const)(
    'recognizes %s in filtering and vocalist search',
    artistType => {
      expect(isVoiceSynthArtistType(artistType)).toBe(true);
      expect(VOCALIST_SEARCH_ARTIST_TYPES).toContain(artistType);
    },
  );

  it('searches human vocalists without treating them as voice synths', () => {
    expect(VOCALIST_SEARCH_ARTIST_TYPES).toContain('OtherVocalist');
    expect(isVoiceSynthArtistType('OtherVocalist')).toBe(false);
  });
});
