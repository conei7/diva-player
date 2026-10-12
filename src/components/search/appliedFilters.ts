import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { DEFAULT_ADVANCED_FILTERS, useSearchStore, type AdvancedSearchFilters } from '../../stores/searchStore';
import { AUDIO_INSTRUMENT_LABELS } from '../../config/audioInstruments';
import { artistRoleLabel, formatClockDuration, formatCompactCount, songTypeLabel } from '../../utils/songMeta';
import type { SongType } from '../../types/vocadb';

export interface AppliedFilterItem {
  key: string;
  label: string;
  /** Removes the condition and searches again right away (the × of the chip). */
  remove: () => void;
}

type Translate = (source: string, values?: Record<string, string | number>) => string;

function formatRange(
  t: Translate,
  label: string,
  from: string,
  to: string,
  format: (value: number) => string,
): string {
  const fromText = from.trim() ? format(Number(from)) : '';
  const toText = to.trim() ? format(Number(to)) : '';
  if (fromText && toText) return t('{label}: {from}〜{to}', { label, from: fromText, to: toText });
  if (fromText) return t('{label}: {from}以上', { label, from: fromText });
  return t('{label}: {to}以下', { label, to: toText });
}

function formatYearRange(t: Translate, from: string, to: string): string {
  if (from.trim() && to.trim()) return t('{from}〜{to}年', { from: from.trim(), to: to.trim() });
  if (from.trim()) return t('{from}年以降', { from: from.trim() });
  return t('{to}年まで', { to: to.trim() });
}

function rerunSearch(): void {
  void useSearchStore.getState().search();
}

function updateFilters(patch: Partial<AdvancedSearchFilters>): void {
  useSearchStore.getState().setAdvancedFilters(patch);
  rerunSearch();
}

/**
 * The conditions currently applied to the search (shown as removable chips under the results toolbar
 * and counted on the 詳細検索 button). The vocalists of the ボーカル search mode are the query itself
 * and are not listed.
 */
export function useAppliedFilterItems(): AppliedFilterItem[] {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const { vocalistFilters, modeVocalistIds, songTypeFilter, advancedFilters } = useSearchStore(useShallow(state => ({
    vocalistFilters: state.vocalistFilters,
    modeVocalistIds: state.modeVocalistIds,
    songTypeFilter: state.songTypeFilter,
    advancedFilters: state.advancedFilters,
  })));

  return useMemo(() => {
    const items: AppliedFilterItem[] = [];
    const filters = advancedFilters;
    const groupCounts = new Map<string, number>();
    for (const filter of vocalistFilters) {
      if (filter.variantGroup) groupCounts.set(filter.variantGroup, (groupCounts.get(filter.variantGroup) ?? 0) + 1);
    }

    const seenGroups = new Set<string>();
    for (const filter of vocalistFilters) {
      if (modeVocalistIds.includes(filter.id)) continue;
      if (filter.variantGroup) {
        if (seenGroups.has(filter.variantGroup)) continue;
        seenGroups.add(filter.variantGroup);
      }
      const group = filter.variantGroup;
      const name = group
        ? t('{group}（{count}音源）', { group, count: groupCounts.get(group) ?? 1 })
        : filter.name;
      items.push({
        key: `vocalist-${group ?? filter.id}`,
        label: t('ボーカル: {name}', { name }),
        remove: () => {
          const store = useSearchStore.getState();
          store.setVocalistFilters(store.vocalistFilters.filter(candidate => (group
            ? candidate.variantGroup !== group
            : candidate.id !== filter.id)));
          rerunSearch();
        },
      });
    }

    if (songTypeFilter === 'Original' && filters.includedSongTypes.length === 0) {
      items.push({
        key: 'original-only',
        label: t('オリジナルのみ'),
        remove: () => {
          useSearchStore.getState().setSongTypeFilter('All');
          rerunSearch();
        },
      });
    }
    for (const type of filters.includedSongTypes) {
      items.push({
        key: `type-${type}`,
        label: songTypeLabel(type as SongType, language),
        remove: () => updateFilters({
          includedSongTypes: useSearchStore.getState().advancedFilters.includedSongTypes.filter(item => item !== type),
        }),
      });
    }
    if (filters.selfCoverOnly) {
      items.push({ key: 'self-cover', label: t('セルフカバーのみ'), remove: () => updateFilters({ selfCoverOnly: false }) });
    }

    if (filters.publishYearFrom.trim() || filters.publishYearTo.trim()) {
      items.push({
        key: 'year',
        label: formatYearRange(t, filters.publishYearFrom, filters.publishYearTo),
        remove: () => updateFilters({ publishYearFrom: '', publishYearTo: '' }),
      });
    }
    if (filters.lengthMinSeconds.trim() || filters.lengthMaxSeconds.trim()) {
      items.push({
        key: 'length',
        label: formatRange(t, t('長さ'), filters.lengthMinSeconds, filters.lengthMaxSeconds, formatClockDuration),
        remove: () => updateFilters({ lengthMinSeconds: '', lengthMaxSeconds: '' }),
      });
    }
    const compact = (value: number) => formatCompactCount(value, language);
    if (filters.minYoutubeViews || filters.maxYoutubeViews) {
      items.push({
        key: 'youtube',
        label: formatRange(t, 'YouTube', filters.minYoutubeViews, filters.maxYoutubeViews, compact),
        remove: () => updateFilters({ minYoutubeViews: '', maxYoutubeViews: '' }),
      });
    }
    if (filters.minNicoViews || filters.maxNicoViews) {
      items.push({
        key: 'niconico',
        label: formatRange(t, t('ニコニコ'), filters.minNicoViews, filters.maxNicoViews, compact),
        remove: () => updateFilters({ minNicoViews: '', maxNicoViews: '' }),
      });
    }
    if (filters.minFavoritedTimes || filters.maxFavoritedTimes) {
      items.push({
        key: 'favorites',
        label: formatRange(t, t('お気に入り数'), filters.minFavoritedTimes, filters.maxFavoritedTimes, compact),
        remove: () => updateFilters({ minFavoritedTimes: '', maxFavoritedTimes: '' }),
      });
    }

    for (const tag of filters.tagFilters) {
      items.push({
        key: `tag-${tag.id}`,
        label: t('タグ: {name}', { name: t(tag.name) }),
        remove: () => updateFilters({
          tagFilters: useSearchStore.getState().advancedFilters.tagFilters.filter(item => item.id !== tag.id),
        }),
      });
    }
    if (filters.creditArtist) {
      const name = filters.creditArtist.name;
      items.push({
        key: 'credit',
        label: filters.creditRole
          ? `${artistRoleLabel(filters.creditRole, language)}: ${name}`
          : t('クレジット: {name}', { name }),
        remove: () => updateFilters({ creditArtist: null }),
      });
    }

    if (filters.bpmFrom.trim() || filters.bpmTo.trim()) {
      items.push({
        key: 'bpm',
        label: formatRange(t, 'BPM', filters.bpmFrom, filters.bpmTo, value => String(value)),
        remove: () => updateFilters({ bpmFrom: '', bpmTo: '' }),
      });
    }
    for (const key of filters.instrumentKeys) {
      const label = AUDIO_INSTRUMENT_LABELS.get(key) ?? key;
      items.push({
        key: `instrument-${key}`,
        label: t('楽器: {name}', { name: t(label) }),
        remove: () => updateFilters({
          instrumentKeys: useSearchStore.getState().advancedFilters.instrumentKeys.filter(item => item !== key),
        }),
      });
    }
    if (filters.audioComputed !== 'any') {
      items.push({
        key: 'audio',
        label: filters.audioComputed === 'yes' ? t('音響解析: 解析済み') : t('音響解析: 未解析'),
        remove: () => updateFilters({ audioComputed: DEFAULT_ADVANCED_FILTERS.audioComputed }),
      });
    }

    if (filters.lyricsQuery.trim()) {
      items.push({
        key: 'lyrics',
        label: t('歌詞: {query}', { query: filters.lyricsQuery.trim() }),
        remove: () => updateFilters({ lyricsQuery: '' }),
      });
    }
    if (filters.pvService !== 'any') {
      items.push({
        key: 'pv',
        label: filters.pvService === 'both'
          ? t('動画: YouTube＋ニコニコ')
          : filters.pvService === 'niconico' ? t('動画: ニコニコ') : t('動画: YouTube'),
        remove: () => updateFilters({ pvService: DEFAULT_ADVANCED_FILTERS.pvService }),
      });
    }
    return items;
  }, [advancedFilters, language, modeVocalistIds, songTypeFilter, t, vocalistFilters]);
}
