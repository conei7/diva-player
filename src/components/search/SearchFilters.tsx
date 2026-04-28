import { useState, useEffect, useRef } from 'react';
import { useSearchStore } from '../../stores/searchStore';
import type { SongSortRule, VocalistMatchMode } from '../../types/vocadb';
import { searchVocalistsByName } from '../../api/vocadb';
import type { Artist } from '../../types/vocadb';

const SORT_OPTIONS: { value: SongSortRule; label: string }[] = [
  { value: 'FavoritedTimes', label: '人気順' },
  { value: 'RatingScore', label: '評価順' },
  { value: 'PublishDate', label: '公開日順' },
  { value: 'AdditionDate', label: '登録日順' },
  { value: 'Name', label: '名前順' },
];

const MATCH_MODES: { value: VocalistMatchMode; label: string }[] = [
  { value: 'Any', label: 'いずれかを含む' },
  { value: 'All', label: 'すべて含む' },
  { value: 'Exact', label: '完全一致' },
];

/**
 * SearchFilters - ソート順・シンガーフィルターなどの検索フィルター
 */
export default function SearchFilters() {
  const {
    sort, setSort, search, totalCount, hasSearched,
    vocalistFilters, vocalistMatchMode,
    addVocalistFilter, removeVocalistFilter, setVocalistMatchMode,
  } = useSearchStore();

  const [vocalistQuery, setVocalistQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Artist[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestRef = useRef<HTMLDivElement>(null);

  // ボーカリスト名でサジェスト検索（300ms デバウンス）
  useEffect(() => {
    if (vocalistQuery.trim().length < 1) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      const results = await searchVocalistsByName(vocalistQuery);
      setSuggestions(results);
      setShowSuggestions(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [vocalistQuery]);

  // サジェスト外クリックで閉じる
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelectVocalist = (v: Artist) => {
    addVocalistFilter({ id: v.id, name: v.name });
    setVocalistQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
    search();
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 上段: 件数 + ソート */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        {hasSearched && (
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            <span style={{ color: 'var(--color-accent-cyan)' }} className="font-semibold">
              {totalCount.toLocaleString()}
            </span>
            {' '}件の結果
          </p>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <label htmlFor="sort-select" className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            並び替え:
          </label>
          <select
            id="sort-select"
            value={sort}
            onChange={(e) => { setSort(e.target.value as SongSortRule); search(); }}
            className="text-sm rounded-lg px-3 py-1.5 outline-none cursor-pointer transition-colors"
            style={{
              background: 'var(--color-surface)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
            }}
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 下段: シンガーフィルター */}
      <div className="rounded-xl p-3 flex flex-col gap-2"
           style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
               style={{ color: 'var(--color-accent-purple)', flexShrink: 0 }}>
            <path d="M12 3a4 4 0 0 1 4 4 4 4 0 0 1-4 4 4 4 0 0 1-4-4 4 4 0 0 1 4-4m0 10c4.42 0 8 1.79 8 4v2H4v-2c0-2.21 3.58-4 8-4z"/>
          </svg>
          <span className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
            シンガーで絞り込み
          </span>
        </div>

        {/* 選択済みチップ */}
        {vocalistFilters.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {vocalistFilters.map(v => (
              <span
                key={v.id}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                style={{
                  background: 'rgba(139, 92, 246, 0.15)',
                  color: 'var(--color-accent-purple)',
                  border: '1px solid rgba(139, 92, 246, 0.35)',
                }}
              >
                {v.name}
                <button
                  onClick={() => { removeVocalistFilter(v.id); search(); }}
                  className="opacity-70 hover:opacity-100 transition-opacity ml-0.5"
                  title="削除"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 入力 + サジェスト */}
        <div className="relative" ref={suggestRef}>
          <input
            type="text"
            value={vocalistQuery}
            onChange={e => setVocalistQuery(e.target.value)}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            placeholder="シンガー名を入力（例: 初音ミク）"
            className="w-full text-sm rounded-lg px-3 py-1.5 outline-none transition-colors"
            style={{
              background: 'var(--color-surface-elevated)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
            }}
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul
              className="absolute top-full left-0 right-0 z-20 mt-1 rounded-lg overflow-hidden shadow-xl"
              style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)' }}
            >
              {suggestions.map(s => (
                <li
                  key={s.id}
                  className="px-3 py-2 text-sm cursor-pointer transition-colors"
                  style={{ color: 'var(--color-text-primary)' }}
                  onMouseDown={() => handleSelectVocalist(s)}
                >
                  <span>{s.name}</span>
                  <span className="ml-2 text-xs opacity-50">{s.artistType}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 一致モード選択（vocalist が 1 つ以上選択済みの場合のみ表示） */}
        {vocalistFilters.length >= 1 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>一致条件:</span>
            {MATCH_MODES.map(m => (
              <button
                key={m.value}
                className="text-xs px-2 py-0.5 rounded transition-colors"
                style={{
                  background: vocalistMatchMode === m.value ? 'rgba(139, 92, 246, 0.2)' : 'transparent',
                  color: vocalistMatchMode === m.value ? 'var(--color-accent-purple)' : 'var(--color-text-muted)',
                  border: vocalistMatchMode === m.value
                    ? '1px solid rgba(139, 92, 246, 0.4)'
                    : '1px solid var(--color-border)',
                }}
                onClick={() => { setVocalistMatchMode(m.value); search(); }}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
