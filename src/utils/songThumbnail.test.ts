import { describe, expect, it } from 'vitest';
import type { PV } from '../types/vocadb';
import { getSongThumbnailCandidates } from './songThumbnail';

function pv(overrides: Partial<PV> & Pick<PV, 'service' | 'pvId'>): PV {
  return {
    author: '',
    disabled: false,
    id: 1,
    length: 0,
    name: '',
    pvType: 'Original',
    url: '',
    ...overrides,
  };
}

describe('getSongThumbnailCandidates', () => {
  it('tries the song image first, then active PV images and YouTube sizes', () => {
    expect(getSongThumbnailCandidates({
      thumbUrl: ' https://vocadb.example/song.jpg ',
      pvs: [
        pv({ service: 'NicoNicoDouga', pvId: 'sm123', thumbUrl: 'https://nico.example/pv.jpg' }),
        pv({ service: 'Youtube', pvId: 'abcdefghijk' }),
      ],
    })).toEqual([
      'https://vocadb.example/song.jpg',
      'https://nico.example/pv.jpg',
      'https://img.youtube.com/vi/abcdefghijk/hqdefault.jpg',
      'https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg',
    ]);
  });

  it('does not use thumbnail sources belonging to disabled PVs', () => {
    const deadThumbnail = 'https://img.youtube.com/vi/abcdefghijk/hqdefault.jpg';
    expect(getSongThumbnailCandidates({
      thumbUrl: deadThumbnail,
      pvs: [pv({ service: 'Youtube', pvId: 'abcdefghijk', disabled: true, thumbUrl: deadThumbnail })],
    })).toEqual([]);
  });

  it('deduplicates repeated URLs and ignores invalid YouTube IDs', () => {
    expect(getSongThumbnailCandidates({
      thumbUrl: 'https://images.example/song.jpg',
      pvs: [
        pv({ service: 'NicoNicoDouga', pvId: 'sm1', thumbUrl: 'https://images.example/song.jpg' }),
        pv({ service: 'Youtube', pvId: 'too-short' }),
      ],
    })).toEqual(['https://images.example/song.jpg']);
  });
});
