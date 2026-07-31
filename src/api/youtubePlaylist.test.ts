import { describe, expect, it } from 'vitest';
import { extractYouTubePlaylistId, normalizeYouTubePlaylistUrl } from './youtubePlaylist';

describe('YouTube playlist URL helpers', () => {
  it('extracts playlist ids from canonical and short URLs', () => {
    expect(extractYouTubePlaylistId('https://www.youtube.com/playlist?list=PL1234567890')).toBe('PL1234567890');
    expect(extractYouTubePlaylistId('https://youtu.be/video?list=PL1234567890')).toBe('PL1234567890');
    expect(extractYouTubePlaylistId('PL1234567890')).toBe('PL1234567890');
  });

  it('rejects malformed or too-short ids', () => {
    expect(extractYouTubePlaylistId('https://www.youtube.com/playlist?list=bad id')).toBeNull();
    expect(extractYouTubePlaylistId('short')).toBeNull();
    expect(extractYouTubePlaylistId('')).toBeNull();
  });

  it('normalizes linked source URLs', () => {
    expect(normalizeYouTubePlaylistUrl('PL1234567890')).toBe('https://www.youtube.com/playlist?list=PL1234567890');
  });
});
