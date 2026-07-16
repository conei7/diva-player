import { describe, expect, it } from 'vitest';
import type { Artist } from '../types/vocadb';
import { rankArtistsByName } from './vocadb';

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
