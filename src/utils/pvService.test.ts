import { describe, expect, it } from 'vitest';
import { getPVServiceLabel } from './pvService';

describe('getPVServiceLabel', () => {
  it('spells out YouTube and Niconico instead of abbreviations', () => {
    expect(getPVServiceLabel('Youtube')).toBe('YouTube');
    expect(getPVServiceLabel('NicoNicoDouga')).toBe('ニコニコ');
  });

  it('does not classify other PV services as NicoNico', () => {
    expect(getPVServiceLabel('Bilibili')).toBe('Bilibili');
    expect(getPVServiceLabel('SoundCloud')).toBe('SoundCloud');
    expect(getPVServiceLabel('Vimeo')).toBe('Vimeo');
  });

  it('uses English labels for localized service names', () => {
    expect(getPVServiceLabel('Youtube', 'en')).toBe('YouTube');
    expect(getPVServiceLabel('NicoNicoDouga', 'en')).toBe('Niconico');
    expect(getPVServiceLabel('File', 'en')).toBe('File');
    expect(getPVServiceLabel('LocalFile', 'en')).toBe('Local');
    expect(getPVServiceLabel('Bilibili', 'en')).toBe('Bilibili');
  });
});
