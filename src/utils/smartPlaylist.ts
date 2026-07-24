import type { SongType, SmartPlaylistRule } from '../types/vocadb';
import { SONG_TYPE_LABELS } from './globalFilters';

export const SMART_DERIVED_SONG_TYPES: SongType[] = ['Cover', 'Remix', 'Arrangement', 'Mashup'];

function formatViewThreshold(value: number): string {
  return value.toLocaleString('ja-JP');
}

export function formatSmartPlaylistRule(rule: SmartPlaylistRule): string[] {
  const summary: string[] = [];
  if (rule.producerName) summary.push(`P: ${rule.producerName}`);
  if (rule.minYoutubeViews > 0) summary.push(`YouTube ${formatViewThreshold(rule.minYoutubeViews)}以上`);
  if (rule.minNicoViews > 0) summary.push(`ニコニコ ${formatViewThreshold(rule.minNicoViews)}以上`);
  if (rule.excludedSongTypes.length > 0) {
    const labels = rule.excludedSongTypes.map(type => SONG_TYPE_LABELS[type] ?? type);
    summary.push(`除外: ${labels.join('・')}`);
  }
  return summary.length > 0 ? summary : ['条件なし'];
}

