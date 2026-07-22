import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artist } from '../types/vocadb';
import { rankArtistsByName, resolveProducerByName, searchVocalistsByName, selectVocalistVariants } from './vocadb';
import { VOCALIST_SEARCH_ARTIST_TYPES } from '../config/voiceSynthTypes';

function artist(id: number, name: string): Artist {
  return { id, name, artistType: 'Producer' };
}

describe('rankArtistsByName', () => {
  it('prefers an exact artist name over API song-count ordering', () => {
    const ranked = rankArtistsByName([
      artist(1, '耳ロボP'),
      artist(2, 'MIMI'),
      artist(3, 'MIMI Official'),
    ], 'MIMI');
    expect(ranked.map(item => item.name)).toEqual(['MIMI', 'MIMI Official', '耳ロボP']);
  });

  it('normalizes case, spacing, punctuation, and full-width characters', () => {
    const ranked = rankArtistsByName([
      artist(1, 'Other Artist'),
      artist(2, 'ＭＩＭＩ'),
    ], ' mimi ');
    expect(ranked[0]?.id).toBe(2);
  });
});

describe('resolveProducerByName', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches enough prefix candidates and selects the exact producer name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          artist(677, '耳ロボP'),
          artist(49431, 'MIMI'),
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const resolved = await resolveProducerByName('MIMI');

    expect(resolved?.id).toBe(49431);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('maxResults=20');
  });
});

describe('searchVocalistsByName', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests every configured voice-synth type including the new VocaDB types', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await searchVocalistsByName('voice-synth-contract');

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get('artistTypes')?.split(',')).toEqual(VOCALIST_SEARCH_ARTIST_TYPES);
    expect(requestUrl.searchParams.get('artistTypes')).toContain('ACEVirtualSinger');
    expect(requestUrl.searchParams.get('artistTypes')).toContain('VOICEVOX');
    expect(requestUrl.searchParams.get('artistTypes')).toContain('AIVOICE');
  });
});

describe('selectVocalistVariants', () => {
  it('groups exact singer names and parenthesized or spaced voicebank variants', () => {
    const candidates: Artist[] = [
      { id: 1, name: 'ずんだもん', artistType: 'UTAU' },
      { id: 2, name: 'ずんだもん (VOICEPEAK)', artistType: 'OtherVoiceSynthesizer' },
      { id: 3, name: 'ずんだもん (CeVIO AI)', artistType: 'CeVIO' },
      { id: 4, name: 'ずんだもん VoiSona', artistType: 'VoiSona' },
      { id: 5, name: 'ずんだもんち', artistType: 'OtherVocalist' },
    ];

    expect(selectVocalistVariants(candidates, 'ずんだもん').map(item => item.id)).toEqual([1, 2, 3, 4]);
  });
});
