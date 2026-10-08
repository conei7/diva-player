import { describe, expect, it } from 'vitest';
import type { Song } from '../types/vocadb';
import { withDefaultSongName } from './entryNames';

describe('entry default names', () => {
  it('shows GEDO instead of the Japanese alternate spelling without mutating saved data', () => {
    const song = { id: 443372, name: 'ゲドウ', defaultName: 'GEDO', defaultNameLanguage: 'Romaji' } as Song;
    expect(withDefaultSongName(song).name).toBe('GEDO');
    expect(song.name).toBe('ゲドウ');
  });

  it('retains Japanese defaults and falls back for older incomplete song records', () => {
    for (const song of [
      { name: '砂の惑星', defaultName: '砂の惑星' },
      { name: 'Imported song' },
      { name: 'Imported song', defaultName: '  ' },
    ]) expect(withDefaultSongName(song as Song)).toBe(song);
  });
});
