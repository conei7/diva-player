import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artist, Song } from '../types/vocadb';
import { attachExternalViews, buildDigRecommendationRequest, getTopSongs, getTrendingSongs, rankArtistsByName, resolveProducerByName, searchVocalistsByName, selectVocalistVariants } from './vocadb';
import { DEFAULT_GLOBAL_FILTER_SETTINGS } from '../stores/globalFilterStore';
import { VOCALIST_SEARCH_ARTIST_TYPES } from '../config/voiceSynthTypes';

function artist(id: number, name: string): Artist {
  return { id, name, artistType: 'Producer' };
}

describe('Dig global filters', () => {
  it('sends the same view, song type, and vocalist constraints to the backend', () => {
    expect(buildDigRecommendationRequest(
      [{ songId: 1, weight: 0.8 }],
      50,
      [2],
      0,
      123,
      {
        ...DEFAULT_GLOBAL_FILTER_SETTINGS,
        enabled: true,
        minYoutubeViews: 10_000,
        excludedSongTypes: ['Cover'],
        vocalistFilters: [{ id: 39, name: '初音ミク', variantGroup: '初音ミク' }],
        vocalistMatchMode: 'Exact',
      },
    )).toMatchObject({
      minYoutubeViews: 10_000,
      excludedSongTypes: ['Cover'],
      vocalistFilters: [{ id: 39, variantGroup: '初音ミク' }],
      vocalistMatchMode: 'Exact',
    });
  });
});

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

describe('attachExternalViews', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not request view counts that are already present', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const songs = [
      { id: 1, youtubeViews: 10, nicoViews: 20 },
      { id: 2, youtubeViews: 30, nicoViews: 40 },
    ] as Song[];

    expect(await attachExternalViews(songs)).toBe(songs);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests only songs with missing external counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 2: { youtubeViews: 50, nicoViews: 60 } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const songs = [
      { id: 1, youtubeViews: 10, nicoViews: 20 },
      { id: 2 },
    ] as Song[];

    const enriched = await attachExternalViews(songs);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('ids=2');
    expect(enriched[0]).toBe(songs[0]);
    expect(enriched[1]).toMatchObject({ id: 2, youtubeViews: 50, nicoViews: 60 });
  });

  it('coalesces concurrent view-count requests into one batch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        91001: { youtubeViews: 100, nicoViews: 200 },
        91002: { youtubeViews: 300, nicoViews: 400 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const [first, second, overlap] = await Promise.all([
      attachExternalViews([{ id: 91001 }] as Song[]),
      attachExternalViews([{ id: 91002 }] as Song[]),
      attachExternalViews([{ id: 91001 }, { id: 91002 }] as Song[]),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('ids=91001,91002');
    expect(first[0]).toMatchObject({ youtubeViews: 100, nicoViews: 200 });
    expect(second[0]).toMatchObject({ youtubeViews: 300, nicoViews: 400 });
    expect(overlap).toMatchObject([
      { youtubeViews: 100, nicoViews: 200 },
      { youtubeViews: 300, nicoViews: 400 },
    ]);
  });
});

describe('trending fallback pagination', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards the page offset to the VocaDB fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    vi.stubGlobal('fetch', fetchMock);

    await getTopSongs(168, 24, 48);

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get('start')).toBe('48');
  });

  it('uses the zero seed for ranking requests without exploration', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getTrendingSongs(30, 24, 0, 'alltime', 0);

    const trendingCall = fetchMock.mock.calls.find(call => String(call[0]).includes('/api/songs/trending'));
    const requestUrl = new URL(String(trendingCall?.[0]), 'https://example.test');
    expect(requestUrl.searchParams.get('seed')).toBe('0');
  });
});

describe('Dig recommendation API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends only bounded temporary seeds and accepts full song payloads', async () => {
    vi.resetModules();
    const { getDigRecommendedSongs } = await import('./vocadb');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ id: 501, name: '未聴の曲', youtubeViews: 10, nicoViews: 20 }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const songs = await getDigRecommendedSongs(
      Array.from({ length: 30 }, (_, index) => ({ songId: index + 1, weight: 1 })),
      100,
      Array.from({ length: 600 }, (_, index) => index + 1),
      0,
      42,
    );

    expect(songs.map(song => song.id)).toEqual([501]);
    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(request.seeds).toHaveLength(24);
    expect(request.favoriteProducerIds).toBeUndefined();
    expect(request.excludeSongIds).toHaveLength(500);
    expect(request.generationSeed).toBe(42);
  });
});
