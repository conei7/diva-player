import type { PV, PVService } from '../types/vocadb';

export const PLAYABLE_PV_SERVICES = new Set<PVService>([
  'Youtube',
  'NicoNicoDouga',
  'SoundCloud',
  'Bilibili',
]);

export function isPlayablePV(pv: Pick<PV, 'service' | 'disabled'>): boolean {
  return !pv.disabled && PLAYABLE_PV_SERVICES.has(pv.service);
}

function normalizeHttpUrl(value: string): string {
  return value.replace(/^http:\/\//i, 'https://');
}

export function getSoundCloudTrackUrl(pv: Pick<PV, 'pvId' | 'url'>): string | null {
  const rawUrl = normalizeHttpUrl(pv.url.trim());
  if (/^https:\/\/(?:www\.)?soundcloud\.com\//i.test(rawUrl)
    || /^https:\/\/api\.soundcloud\.com\/tracks\/\d+/i.test(rawUrl)) {
    return rawUrl;
  }

  const pvId = pv.pvId.trim();
  if (/^https?:\/\//i.test(pvId)) return normalizeHttpUrl(pvId);

  const slug = pvId.replace(/^\d+\s+/, '').replace(/^\/+|\/+$/g, '');
  if (slug.includes('/')) return `https://soundcloud.com/${slug}`;

  const trackId = pvId.match(/^\d+/)?.[0];
  return trackId ? `https://api.soundcloud.com/tracks/${trackId}` : null;
}

export function buildSoundCloudEmbedUrl(
  pv: Pick<PV, 'pvId' | 'url'>,
  autoplay: boolean,
): string | null {
  const trackUrl = getSoundCloudTrackUrl(pv);
  if (!trackUrl) return null;

  const params = new URLSearchParams({
    url: trackUrl,
    auto_play: autoplay ? 'true' : 'false',
    hide_related: 'true',
    show_comments: 'false',
    show_reposts: 'false',
    show_user: 'true',
    visual: 'true',
  });
  return `https://w.soundcloud.com/player/?${params.toString()}`;
}

export function buildBilibiliEmbedUrl(
  pv: Pick<PV, 'pvId' | 'url'>,
  autoplay: boolean,
  muted = false,
): string | null {
  const source = `${pv.pvId} ${pv.url}`;
  const bvid = source.match(/(?:\/video\/)?(BV[0-9A-Za-z]+)/i)?.[1];
  const aid = source.match(/\/video\/av(\d+)/i)?.[1]
    ?? pv.pvId.trim().match(/^(?:av)?(\d+)$/i)?.[1];
  if (!bvid && !aid) return null;

  const params = new URLSearchParams({
    autoplay: autoplay ? '1' : '0',
    muted: muted ? '1' : '0',
    danmaku: '0',
    high_quality: '1',
  });
  if (bvid) params.set('bvid', bvid);
  else if (aid) params.set('aid', aid);
  return `https://player.bilibili.com/player.html?${params.toString()}`;
}
