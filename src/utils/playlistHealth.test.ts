import { describe, expect, it } from 'vitest';
import type { PVService, Song } from '../types/vocadb';
import { analyzePlaylistHealth } from './playlistHealth';

const song = (id: number, pvs?: Song['pvs']): Song => ({
  id,
  name: `song-${id}`,
  artistString: 'artist',
  defaultName: `song-${id}`,
  defaultNameLanguage: 'Japanese',
  createDate: '',
  favoritedTimes: 0,
  lengthSeconds: 120,
  pvs,
  pvServices: '',
  ratingScore: 0,
  songType: 'Original',
  status: 'Finished',
  version: 1,
});

const pv = (service: PVService, disabled = false) => ({
  id: 1,
  pvId: 'pv',
  service,
  pvType: 'Original' as const,
  url: '',
  disabled,
  length: 120,
  name: 'pv',
  author: '',
});

describe('analyzePlaylistHealth', () => {
  it('classifies missing, disabled, unsupported and duplicate entries', () => {
    const report = analyzePlaylistHealth([
      song(1),
      song(2, [pv('Youtube', true)]),
      song(3, [pv('Vimeo')]),
      song(4, [pv('Youtube')]),
      song(4, [pv('Youtube')]),
    ]);

    expect(report.counts).toEqual({
      duplicate: 1,
      'no-pv': 1,
      'all-pv-disabled': 1,
      'no-playable-pv': 1,
    });
    expect(report.entries.map(entry => entry.index)).toEqual([0, 1, 2, 4]);
    expect(report.entries[3].issues).toEqual(['duplicate']);
  });

  it('does not flag a song with an enabled supported PV', () => {
    const report = analyzePlaylistHealth([
      song(1, [pv('Youtube', true), pv('SoundCloud')]),
    ]);
    expect(report.entries).toHaveLength(0);
  });
});
