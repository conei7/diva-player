import type { SortKey } from '../../stores/playlistStore';

interface PlaylistToolbarProps {
  query: string;
  sortKey: SortKey;
  resultCount: number;
  totalCount: number;
  selectionMode: boolean;
  duplicateCount: number;
  healthIssueCount: number;
  externalLinked: boolean;
  onQueryChange: (value: string) => void;
  onSortChange: (value: SortKey) => void;
  onRemoveDuplicates: () => void;
  onOpenHealth: () => void;
  onToggleSelection: () => void;
  onSelectAll: () => void;
}

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'addedOrder', label: '追加順' },
  { value: 'name', label: '曲名' },
  { value: 'artist', label: 'アーティスト' },
  { value: 'publishDate', label: '公開日' },
];

export default function PlaylistToolbar({
  query,
  sortKey,
  resultCount,
  totalCount,
  selectionMode,
  duplicateCount,
  healthIssueCount,
  externalLinked,
  onQueryChange,
  onSortChange,
  onRemoveDuplicates,
  onOpenHealth,
  onToggleSelection,
  onSelectAll,
}: PlaylistToolbarProps) {
  return (
    <div className="sticky top-0 z-20 rounded-2xl border border-white/[0.09] bg-neutral-950/90 p-2.5 shadow-xl shadow-black/10 backdrop-blur-xl">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[13rem] flex-1 lg:max-w-sm">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input
            type="search"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            placeholder="曲名・アーティストを検索"
            className="search-input min-h-10 w-full rounded-xl pl-10 pr-10 text-sm"
          />
          {query && (
            <button type="button" onClick={() => onQueryChange('')} className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-500 hover:bg-white/10 hover:text-white" aria-label="曲検索をクリア">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        <div className="hidden items-center rounded-xl bg-black/20 p-1 sm:flex" aria-label="曲の並べ替え">
          {SORT_OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              onClick={() => onSortChange(option.value)}
              aria-pressed={sortKey === option.value}
              disabled={externalLinked}
              className={`min-h-9 rounded-lg px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${sortKey === option.value ? 'bg-white/10 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-200'}`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <select
          className="input min-h-10 min-w-[7.5rem] rounded-xl text-xs sm:hidden"
          value={sortKey}
          onChange={event => onSortChange(event.target.value as SortKey)}
          disabled={externalLinked}
          aria-label="曲の並べ替え"
        >
          {SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>

        <button
          type="button"
          onClick={onOpenHealth}
          className={`flex min-h-10 items-center gap-1.5 rounded-xl border px-3 text-xs transition-colors ${healthIssueCount > 0 ? 'border-amber-300/25 bg-amber-300/[0.08] text-amber-100 hover:bg-amber-300/15' : 'border-white/10 text-neutral-400 hover:bg-white/[0.06] hover:text-white'}`}
          title="重複や再生できないPVを確認"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" /><path d="M12 8v4m0 4h.01" /></svg>
          健全性{healthIssueCount > 0 ? ` ${healthIssueCount}` : ''}
        </button>

        {duplicateCount > 0 && (
          <button type="button" disabled={externalLinked} onClick={onRemoveDuplicates} className="min-h-10 rounded-xl border border-amber-300/25 px-3 text-xs text-amber-200 transition-colors hover:bg-amber-300/10 disabled:opacity-40">
            重複削除 {duplicateCount}
          </button>
        )}

        <button
          type="button"
          onClick={onToggleSelection}
          className={`flex min-h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${selectionMode ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100' : 'border-white/10 text-neutral-400 hover:bg-white/[0.06] hover:text-white'}`}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" />{selectionMode && <path d="m8 12 3 3 5-6" />}</svg>
          {selectionMode ? '選択を終了' : '複数選択'}
        </button>
        {selectionMode && (
          <button type="button" onClick={onSelectAll} className="min-h-10 rounded-xl border border-white/10 px-3 text-xs text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white">すべて選択</button>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between px-1 text-[10px] text-neutral-600">
        <span>{query ? `${resultCount} / ${totalCount}曲を表示` : `${totalCount}曲`}</span>
        {externalLinked && <span>外部同期の順序を保持しています</span>}
      </div>
    </div>
  );
}
