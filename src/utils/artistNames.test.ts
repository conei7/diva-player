import { describe, expect, it } from 'vitest';
import { formatDistinctArtistNames } from './artistNames';

describe('formatDistinctArtistNames', () => {
  it('removes exact duplicate names', () => {
    expect(formatDistinctArtistNames(['ずんだもん', 'ずんだもん'])).toBe('ずんだもん');
  });

  it('collapses voicebank variants when the base singer is also present', () => {
    expect(formatDistinctArtistNames([
      'ずんだもん',
      'ずんだもん (VOICEPEAK)',
      'ずんだもん (Seiren Voice)',
      '初音ミク',
    ])).toBe('ずんだもん（複数音源）, 初音ミク');
  });

  it('keeps a standalone voicebank label intact', () => {
    expect(formatDistinctArtistNames(['ずんだもん (VOICEPEAK)', '四国めたん']))
      .toBe('ずんだもん (VOICEPEAK), 四国めたん');
  });
});
