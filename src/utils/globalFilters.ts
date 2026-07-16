import type { Song, SongType } from '../types/vocadb';
import type { GlobalFilterSettings } from '../stores/globalFilterStore';

export interface DiscoveryFilterContext {
  settings: GlobalFilterSettings;
  ratings?: Record<string, number>;
  lastPlayedAtBySongId?: ReadonlyMap<number, number | null>;
  now?: number;
}

function meetsMinimumViews(minimum: number, value: number | undefined): boolean {
  if (minimum <= 0) return true;
  return value !== undefined && Number.isFinite(value) && value >= minimum;
}

export function matchesGlobalSongFilter(song: Song, settings: GlobalFilterSettings): boolean {
  if (!settings.enabled) return true;
  if (settings.excludedSongTypes.includes(song.songType)) return false;
  if (!meetsMinimumViews(settings.minYoutubeViews, song.youtubeViews)) return false;
  if (!meetsMinimumViews(settings.minNicoViews, song.nicoViews)) return false;
  return true;
}

export function applyGlobalSongFilter(songs: Song[], settings: GlobalFilterSettings): Song[] {
  return songs.filter(song => matchesGlobalSongFilter(song, settings));
}

export function matchesDiscoveryFilter(song: Song, context: DiscoveryFilterContext): boolean {
  const { settings, ratings, lastPlayedAtBySongId, now = Date.now() } = context;
  if (!matchesGlobalSongFilter(song, settings)) return false;

  if (settings.excludeRatedFromDiscovery && (ratings?.[String(song.id)] ?? 0) > 0) return false;

  if (settings.cooldownHours > 0) {
    const lastPlayedAt = lastPlayedAtBySongId?.get(song.id) ?? null;
    if (lastPlayedAt !== null && lastPlayedAt !== undefined) {
      const cooldownMs = settings.cooldownHours * 60 * 60 * 1000;
      if (now - lastPlayedAt < cooldownMs) return false;
    }
  }

  return true;
}

export function applyDiscoveryFilter(songs: Song[], context: DiscoveryFilterContext): Song[] {
  return songs.filter(song => matchesDiscoveryFilter(song, context));
}

export function isSongType(value: string): value is SongType {
  return [
    'Original', 'Remaster', 'Remix', 'Cover', 'Arrangement', 'Instrumental',
    'Mashup', 'MusicPV', 'DramaPV', 'Other', 'Unspecified',
  ].includes(value as SongType);
}
