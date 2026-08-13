import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artist, Song } from '../types/vocadb';
import { attachExternalViews, buildDigRecommendationRequest, filterDiscoveryEligibleSongs, getDiscoveryEligibleSongIds, getSongById, getSongsByIds, getTopSongs, getTrendingSongs, rankArtistsByName, resolveProducerByName, searchVocalistsByName, selectVocalistVariants } from './vocadb';
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

describe('recommendation song detail batching', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coalesces concurrent recommendation details into one ordered SBC request', async () => {
    const songs = [
      { id: 92001, name: 'one', youtubeViews: 1, nicoViews: 2 },
      { id: 92002, name: 'two', youtubeViews: 3, nicoViews: 4 },
      { id: 92003, name: 'three', youtubeViews: 5, nicoViews: 6 },
    ] as Song[];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: songs }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      getSongsByIds([92002, 92001]),
      getSongsByIds([92003, 92002]),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/songs/batch?ids=92001,92002,92003');
    expect(first.map(song => song.id)).toEqual([92002, 92001]);
    expect(second.map(song => song.id)).toEqual([92003, 92002]);
  });

  it('falls back to VocaDB song details when the SBC batch route is unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 92004,
          name: 'fallback',
          youtubeViews: 7,
          nicoViews: 8,
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const songs = await getSongsByIds([92004]);

    expect(songs.map(song => song.id)).toEqual([92004]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/songs/batch?ids=92004');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/songs/details?ids=92004');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/api/songs/92004?');
  });

  it('keeps compact cards separate from full watch-page details', async () => {
    const compact = { id: 92005, name: 'compact', pvs: [{ id: 1, pvId: 'x', service: 'Youtube' }] } as Song;
    const full = { id: 92005, name: 'full', pvs: [{ id: 1, pvId: 'x', service: 'Youtube', description: 'full description' }] } as Song;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [compact] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [full] }) });
    vi.stubGlobal('fetch', fetchMock);

    const cards = await getSongsByIds([92005]);
    const details = await getSongById(92005);

    expect(cards[0]?.pvs?.[0]?.description).toBeUndefined();
    expect(details.pvs?.[0]?.description).toBe('full description');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/songs/details?ids=92005');
  });

  it('coalesces concurrent full song details into one SBC request', async () => {
    const songs = [
      { id: 92006, name: 'full-one' },
      { id: 92007, name: 'full-two' },
    ] as Song[];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: songs }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const details = await Promise.all([getSongById(92007), getSongById(92006)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/songs/details?ids=92006,92007');
    expect(details.map(song => song.id)).toEqual([92007, 92006]);
  });
});

describe('authoritative discovery eligibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps an eligible synth cover and excludes a manually rejected stale playlist song', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { songId: 566566, discoveryEligible: true },
            { songId: 933455, discoveryEligible: false },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { songId: 566566, discoveryEligible: false },
            { songId: 933455, discoveryEligible: false },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const staleLocalSongs = [
      { id: 566566, name: 'eligible synth cover' },
      { id: 933455, name: 'manually excluded' },
    ] as Song[];

    const first = await filterDiscoveryEligibleSongs(staleLocalSongs);
    const second = await filterDiscoveryEligibleSongs(staleLocalSongs);

    expect(first.map(song => song.id)).toEqual([566566]);
    expect(second).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/api/songs/discovery-eligibility?ids=566566,933455',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });
  });

  it('removes a manual exclusion returned by the public VocaDB recommendation fallback', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/ready')) {
        return { ok: true, status: 200 };
      }
      if (url.includes('/api/recommend?')) {
        return { ok: false, status: 503 };
      }
      if (url.includes('/songs/42/related?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            likeMatches: [
              { id: 933455, name: 'excluded fallback', youtubeViews: 1, nicoViews: 1 },
              { id: 566566, name: 'eligible synth cover', youtubeViews: 1, nicoViews: 1 },
            ],
            artistMatches: [],
            tagMatches: [],
          }),
        };
      }
      if (url.includes('/api/songs/discovery-eligibility?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { songId: 933455, discoveryEligible: false },
              { songId: 566566, discoveryEligible: true },
            ],
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const fallbackApi = await import('./vocadb');

    const fallbackSongs = await fallbackApi.getRecommendedSongs(42, 10);
    const filtered = await fallbackApi.filterDiscoveryEligibleSongs(fallbackSongs);

    expect(fallbackSongs.map(song => song.id)).toEqual([933455, 566566]);
    expect(filtered.map(song => song.id)).toEqual([566566]);
    expect(fetchMock.mock.calls.some(call =>
      String(call[0]).includes('/api/songs/discovery-eligibility?ids=933455,566566'))).toBe(true);
  });

  it('chunks more than 500 IDs and fails closed for an unavailable chunk', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: Array.from({ length: 500 }, (_, index) => ({
            songId: index + 1,
            discoveryEligible: true,
          })),
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const eligible = await getDiscoveryEligibleSongIds(
      Array.from({ length: 501 }, (_, index) => index + 1),
      controller.signal,
    );

    expect(eligible.size).toBe(500);
    expect(eligible.has(500)).toBe(true);
    expect(eligible.has(501)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstIds = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://localhost')
      .searchParams.get('ids')?.split(',');
    const secondIds = new URL(String(fetchMock.mock.calls[1]?.[0]), 'http://localhost')
      .searchParams.get('ids')?.split(',');
    expect(firstIds).toHaveLength(500);
    expect(secondIds).toEqual(['501']);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
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
