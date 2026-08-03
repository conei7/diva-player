import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useHiddenSongStore } from '../stores/hiddenSongStore';

type SortMode = 'recent' | 'name';

function thumbnail(song: { thumbUrl?: string; pvs?: Array<{ service: string; pvId: string }> }): string | null {
  if (song.thumbUrl) return song.thumbUrl;
  const youtube = song.pvs?.find(pv => pv.service === 'Youtube');
  return youtube ? `https://img.youtube.com/vi/${youtube.pvId}/mqdefault.jpg` : null;
}

export default function HiddenSongsPage() {
  const hiddenSongs = useHiddenSongStore(state => state.hiddenSongs);
  const restoreSong = useHiddenSongStore(state => state.restoreSong);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');

  const records = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ja');
    const items = Object.values(hiddenSongs).filter(record => !normalized
      || record.song.name.toLocaleLowerCase('ja').includes(normalized)
      || record.song.artistString?.toLocaleLowerCase('ja').includes(normalized));
    return items.sort((a, b) => sortMode === 'name'
      ? a.song.name.localeCompare(b.song.name, 'ja')
      : b.hiddenAt - a.hiddenAt);
  }, [hiddenSongs, query, sortMode]);

  return (
    <div className="w-full px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <p className="mb-1 text-xs font-medium uppercase tracking-[0.18em]" style={{ color: '#fb7185' }}>Preference controls</p>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--color-text-primary)' }}>表示しない曲</h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            ここにある曲は検索、おすすめ、自動再生候補に表示されません。星評価や履歴、プレイリストの記録は削除していません。
          </p>
        </div>

        <div className="mb-5 flex flex-col gap-2 sm:flex-row">
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="曲名・アーティスト"
            className="min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-sm outline-none"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
          />
          <select
            value={sortMode}
            onChange={event => setSortMode(event.target.value as SortMode)}
            className="ui-select sm:w-40"
            aria-label="並び順"
          >
            <option value="recent">追加が新しい順</option>
            <option value="name">曲名順</option>
          </select>
        </div>

        <p className="mb-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>{records.length.toLocaleString()} 曲</p>

        {records.length === 0 ? (
          <div className="rounded-2xl border px-6 py-16 text-center" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <p className="text-base font-medium" style={{ color: 'var(--color-text-primary)' }}>
              {Object.keys(hiddenSongs).length === 0 ? '表示しない曲はありません' : '条件に合う曲がありません'}
            </p>
            <p className="mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>再生画面の「表示しない」から追加できます。</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            {records.map(record => {
              const image = thumbnail(record.song);
              return (
                <div key={record.song.id} className="flex flex-wrap items-center gap-3 border-b p-3 last:border-b-0 sm:flex-nowrap" style={{ borderColor: 'var(--color-border)' }}>
                  <div className="h-14 w-24 flex-shrink-0 overflow-hidden rounded-lg" style={{ background: 'var(--color-bg-secondary)' }}>
                    {image && <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>{record.song.name}</p>
                    <p className="truncate text-xs" style={{ color: 'var(--color-text-secondary)' }}>{record.song.artistString}</p>
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                      {new Date(record.hiddenAt).toLocaleDateString('ja-JP')} に非表示
                    </p>
                  </div>
                  <div className="ml-auto flex w-full justify-end gap-2 sm:w-auto">
                    <Link className="btn-ghost rounded-full px-3 py-2 text-xs" to={`/watch?v=${record.song.id}&autoplay=0`}>確認</Link>
                    <button type="button" className="btn-secondary rounded-full px-3 py-2 text-xs" onClick={() => restoreSong(record.song.id)}>
                      再表示
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
