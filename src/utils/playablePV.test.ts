import { describe, expect, it } from 'vitest';
import type { PV } from '../types/vocadb';
import {
  buildBilibiliEmbedUrl,
  buildSoundCloudEmbedUrl,
  getSoundCloudTrackUrl,
  isPlayablePV,
} from './playablePV';

const pv = (overrides: Partial<PV>): PV => ({
  author: '',
  disabled: false,
  id: 1,
  length: 120,
  name: 'fixture',
  pvId: '',
  pvType: 'Original',
  service: 'Youtube',
  url: '',
  ...overrides,
});

describe('playable PV services', () => {
  it('supports YouTube, NicoNico, SoundCloud and Bilibili only', () => {
    expect(isPlayablePV(pv({ service: 'Youtube' }))).toBe(true);
    expect(isPlayablePV(pv({ service: 'NicoNicoDouga' }))).toBe(true);
    expect(isPlayablePV(pv({ service: 'SoundCloud' }))).toBe(true);
    expect(isPlayablePV(pv({ service: 'Bilibili' }))).toBe(true);
    expect(isPlayablePV(pv({ service: 'Vimeo' }))).toBe(false);
    expect(isPlayablePV(pv({ service: 'SoundCloud', disabled: true }))).toBe(false);
  });
});

describe('SoundCloud embed URL', () => {
  it('prefers and upgrades the VocaDB public URL', () => {
    const target = getSoundCloudTrackUrl(pv({
      service: 'SoundCloud',
      pvId: '103524583 worldoncolorkoyori/feat-5',
      url: 'http://soundcloud.com/worldoncolorkoyori/feat-5',
    }));
    expect(target).toBe('https://soundcloud.com/worldoncolorkoyori/feat-5');
  });

  it('falls back to the slug stored after the numeric track ID', () => {
    const embed = buildSoundCloudEmbedUrl(pv({
      service: 'SoundCloud',
      pvId: '1438127221 pinocchiop-music/kusare-gedou-and-chocolate-1',
    }), true);
    const url = new URL(embed!);
    expect(url.origin).toBe('https://w.soundcloud.com');
    expect(url.searchParams.get('url')).toBe('https://soundcloud.com/pinocchiop-music/kusare-gedou-and-chocolate-1');
    expect(url.searchParams.get('auto_play')).toBe('true');
  });
});

describe('Bilibili embed URL', () => {
  it('builds an aid embed from the numeric VocaDB pvId', () => {
    const embed = new URL(buildBilibiliEmbedUrl(pv({
      service: 'Bilibili',
      pvId: '45451154',
      url: 'https://www.bilibili.com/video/av45451154',
    }), true, false)!);
    expect(embed.origin).toBe('https://player.bilibili.com');
    expect(embed.searchParams.get('aid')).toBe('45451154');
    expect(embed.searchParams.get('autoplay')).toBe('1');
    expect(embed.searchParams.get('muted')).toBe('0');
    expect(embed.searchParams.get('danmaku')).toBe('0');
  });

  it('accepts newer BV identifiers', () => {
    const embed = new URL(buildBilibiliEmbedUrl(pv({
      service: 'Bilibili',
      pvId: 'BV1xx411c7mD',
    }), false)!);
    expect(embed.searchParams.get('bvid')).toBe('BV1xx411c7mD');
    expect(embed.searchParams.get('muted')).toBe('0');
  });
});
