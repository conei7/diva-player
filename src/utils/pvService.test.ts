import { describe, expect, it } from 'vitest';
import { getPVServiceLabel } from './pvService';

describe('getPVServiceLabel', () => {
  it('keeps YouTube and NicoNico labels compact', () => {
    expect(getPVServiceLabel('Youtube')).toBe('YT');
    expect(getPVServiceLabel('NicoNicoDouga')).toBe('ニコ');
  });

  it('does not classify other PV services as NicoNico', () => {
    expect(getPVServiceLabel('Bilibili')).toBe('Bilibili');
    expect(getPVServiceLabel('SoundCloud')).toBe('SoundCloud');
    expect(getPVServiceLabel('Vimeo')).toBe('Vimeo');
  });

  it('uses English labels for localized service names', () => {
    expect(getPVServiceLabel('NicoNicoDouga', 'en')).toBe('Niconico');
    expect(getPVServiceLabel('File', 'en')).toBe('File');
    expect(getPVServiceLabel('LocalFile', 'en')).toBe('Local');
    expect(getPVServiceLabel('Bilibili', 'en')).toBe('Bilibili');
  });
});
