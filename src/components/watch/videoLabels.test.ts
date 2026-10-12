import { describe, expect, it } from 'vitest';
import { shortVideoName, videoSourceLabel, withVideoName } from './videoLabels';

/** Stand-in for useTranslateSourceText(): the English template of 「{service}（{kind}）」. */
function translator(language: 'ja' | 'en') {
  return (source: string, values: Record<string, string | number> = {}) => {
    const template = language === 'en' && source === '{service}（{kind}）' ? '{service} ({kind})' : source;
    return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
  };
}

describe('videoSourceLabel', () => {
  it('names the service and the kind', () => {
    expect(videoSourceLabel({ service: 'Youtube', pvType: 'Original' }, 'ja', translator('ja'))).toBe('YouTube（公式）');
    expect(videoSourceLabel({ service: 'NicoNicoDouga', pvType: 'Reprint' }, 'ja', translator('ja'))).toBe('ニコニコ（転載）');
  });

  it('writes the English kind in lower case after the service name', () => {
    expect(videoSourceLabel({ service: 'Youtube', pvType: 'Original' }, 'en', translator('en'))).toBe('YouTube (official)');
    expect(videoSourceLabel({ service: 'NicoNicoDouga', pvType: 'Reprint' }, 'en', translator('en'))).toBe('Niconico (reupload)');
    expect(videoSourceLabel({ service: 'SoundCloud', pvType: 'Other' }, 'en', translator('en'))).toBe('SoundCloud (other)');
  });
});

describe('withVideoName', () => {
  const videos = [
    { service: 'Youtube', pvType: 'Original', name: 'シャルル／バルーン(self cover)' },
    { service: 'Youtube', pvType: 'Original', name: 'シャルル (self cover)' },
    { service: 'NicoNicoDouga', pvType: 'Original', name: 'シャルル／バルーン' },
    { service: 'Youtube', pvType: 'Other', name: 'シャルル (lyrics)' },
  ];

  it('adds a short video name only when another video has the same service and kind', () => {
    expect(withVideoName('YouTube', videos[0], videos, 'ja')).toBe('YouTube · シャルル／バルーン(self cover)');
    expect(withVideoName('YouTube', videos[1], videos, 'en')).toBe('YouTube · シャルル (self cover)');
    expect(withVideoName('ニコニコ', videos[2], videos, 'ja')).toBe('ニコニコ');
    expect(withVideoName('YouTube (other)', videos[3], videos, 'en')).toBe('YouTube (other)');
  });

  it('adds the release date when the names are the same too', () => {
    const topic = [
      { service: 'Youtube', pvType: 'Original', name: 'きゅうくらりん', publishDate: '2021-09-04T00:00:00Z' },
      { service: 'Youtube', pvType: 'Original', name: 'きゅうくらりん', publishDate: '2021-12-21T00:00:00Z' },
    ];
    expect(withVideoName('YouTube', topic[0], topic, 'ja')).toBe('YouTube · きゅうくらりん · 2021年9月4日');
    expect(withVideoName('Open on YouTube', topic[1], topic, 'en')).toBe('Open on YouTube · きゅうくらりん · Dec 21, 2021');
  });

  it('keeps the label when the video has no name', () => {
    const unnamed = [{ service: 'Youtube', pvType: 'Original', name: '' }, { service: 'Youtube', pvType: 'Original' }];
    expect(withVideoName('YouTube', unnamed[0], unnamed, 'ja')).toBe('YouTube');
  });
});

describe('shortVideoName', () => {
  it('cuts long names to 24 characters', () => {
    expect(shortVideoName('  short  ')).toBe('short');
    expect(shortVideoName('a'.repeat(30))).toBe(`${'a'.repeat(23)}…`);
    expect(Array.from(shortVideoName('🎵'.repeat(30)))).toHaveLength(24);
  });
});
