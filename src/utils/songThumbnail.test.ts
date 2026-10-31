import { describe, expect, it } from 'vitest';
import type { PV } from '../types/vocadb';
import { getSongThumbnailCandidates, getSquareSongThumbnailCandidates, getWideSongThumbnailCandidates } from './songThumbnail';

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

describe('getWideSongThumbnailCandidates', () => {
  it('puts the 16:9 YouTube images first and keeps the remaining candidates once', () => {
    expect(getWideSongThumbnailCandidates({
      thumbUrl: 'https://vocadb.example/song.jpg',
      pvs: [
        pv({ service: 'NicoNicoDouga', pvId: 'sm123', thumbUrl: 'https://nico.example/pv.jpg' }),
        pv({ service: 'Youtube', pvId: 'abcdefghijk' }),
      ],
    })).toEqual([
      'https://img.youtube.com/vi/abcdefghijk/mqdefault.jpg',
      'https://img.youtube.com/vi/abcdefghijk/hqdefault.jpg',
      'https://vocadb.example/song.jpg',
      'https://nico.example/pv.jpg',
    ]);
  });

  it('prefers the official YouTube PV and skips disabled ones', () => {
    expect(getWideSongThumbnailCandidates({
      pvs: [
        pv({ service: 'Youtube', pvId: 'reupload111', pvType: 'Reprint' }),
        pv({ service: 'Youtube', pvId: 'disabled111', disabled: true }),
        pv({ service: 'Youtube', pvId: 'official111' }),
      ],
    })).toEqual([
      'https://img.youtube.com/vi/official111/mqdefault.jpg',
      'https://img.youtube.com/vi/official111/hqdefault.jpg',
      'https://img.youtube.com/vi/reupload111/mqdefault.jpg',
      'https://img.youtube.com/vi/reupload111/hqdefault.jpg',
    ]);
  });

  it('falls back to the regular candidates when there is no YouTube PV', () => {
    expect(getWideSongThumbnailCandidates({
      thumbUrl: 'https://vocadb.example/song.jpg',
      pvs: [pv({ service: 'NicoNicoDouga', pvId: 'sm1' })],
    })).toEqual(['https://vocadb.example/song.jpg']);
  });
});

describe('getSquareSongThumbnailCandidates', () => {
  it('crops the 16:9 YouTube image first and leaves letterboxed hqdefault images for last', () => {
    expect(getSquareSongThumbnailCandidates({
      thumbUrl: 'https://vocadb.example/song.jpg',
      pvs: [
        pv({ service: 'Youtube', pvId: 'reupload000', pvType: 'Reprint' }),
        pv({ service: 'Youtube', pvId: 'official000' }),
        pv({ service: 'NicoNicoDouga', pvId: 'sm1', thumbUrl: 'https://nico.example/pv.jpg' }),
      ],
    })).toEqual([
      'https://img.youtube.com/vi/official000/mqdefault.jpg',
      'https://img.youtube.com/vi/reupload000/mqdefault.jpg',
      'https://vocadb.example/song.jpg',
      'https://nico.example/pv.jpg',
      'https://img.youtube.com/vi/official000/hqdefault.jpg',
      'https://img.youtube.com/vi/reupload000/hqdefault.jpg',
    ]);
  });

  it('uses the song image alone when there is no YouTube video', () => {
    expect(getSquareSongThumbnailCandidates({ thumbUrl: 'https://vocadb.example/song.jpg', pvs: [] }))
      .toEqual(['https://vocadb.example/song.jpg']);
  });
});
