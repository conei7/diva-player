import { useHistoryStore } from '../../stores/historyStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useRatingStore } from '../../stores/ratingStore';
import StarRating from './StarRating';
import type { Song } from '../../types/vocadb';

/** Unix timestamp から相対時刻文字列を生成 */
function getRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours   = Math.floor(diff / 3_600_000);
  const days    = Math.floor(diff / 86_400_000);

  if (minutes < 1)  return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  if (hours   < 24) return `${hours}時間前`;
  if (days    === 1) return '昨日';
  if (days    < 7)  return `${days}日前`;
  return new Date(timestamp).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
}

/** YouTube PV からサムネイル URL を生成 */
function getThumbUrl(song: Song): string | null {
  if (song.thumbUrl) return song.thumbUrl;
  const ytPv = song.pvs?.find(pv => pv.service === 'Youtube');
  if (ytPv) return `https://img.youtube.com/vi/${ytPv.pvId}/mqdefault.jpg`;
  return null;
}

/** アーティスト文字列からプロデューサー部分を抽出 */
function getProducerString(song: Song): string {
  const str = song.artistString ?? '';
  const featIdx = str.indexOf(' feat. ');
  return featIdx !== -1 ? str.slice(0, featIdx) : str;
}

export default function HistoryDrawer() {
  const { entries, clearHistory } = useHistoryStore();
  const {
    historyDrawerOpen, toggleHistoryDrawer,
    playSong,
  } = usePlayerStore();
  const { getRating, setRating } = useRatingStore();

  return (
    <>
      {/* オーバーレイ */}
      {historyDrawerOpen && (
        <div
          className="fixed inset-0 z-40"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={toggleHistoryDrawer}
          aria-hidden="true"
        />
      )}

      {/* ドロワー本体 */}
      <div
        className="fixed top-0 right-0 z-50 h-full flex flex-col"
        style={{
          width: '360px',
          maxWidth: '90vw',
          background: 'var(--color-surface)',
          borderLeft: '1px solid var(--color-border)',
          transform: historyDrawerOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
          paddingBottom: 'var(--player-bar-height)',
          boxShadow: historyDrawerOpen ? '-8px 0 32px rgba(0,0,0,0.4)' : 'none',
        }}
        role="dialog"
        aria-label="視聴履歴"
      >
        {/* ヘッダー */}
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
                 style={{ color: 'var(--color-accent-cyan)' }}>
              <path d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3zm7 1-4 4 4-4zM11 8v5l4.28 2.54.72-1.21-3.5-2.08V8H11z"/>
            </svg>
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              視聴履歴
            </span>
            {entries.length > 0 && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded-full"
                style={{
                  background: 'rgba(6, 182, 212, 0.15)',
                  color: 'var(--color-accent-cyan)',
                }}
              >
                {entries.length}件
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {entries.length > 0 && (
              <button
                className="btn-ghost px-2 py-1 rounded-lg text-[11px]"
                style={{ color: 'var(--color-text-muted)' }}
                onClick={() => {
                  if (window.confirm('視聴履歴をすべて削除しますか？')) clearHistory();
                }}
                title="履歴を全件削除"
              >
                全件削除
              </button>
            )}
            <button
              className="btn-ghost p-1.5 rounded-lg"
              onClick={toggleHistoryDrawer}
              aria-label="閉じる"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
                   style={{ color: 'var(--color-text-muted)' }}>
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          </div>
        </div>

        {/* 履歴リスト */}
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 px-4"
                 style={{ color: 'var(--color-text-muted)' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.3 }}>
                <path d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3zm7 1-4 4 4-4zM11 8v5l4.28 2.54.72-1.21-3.5-2.08V8H11z"/>
              </svg>
              <p className="text-sm text-center">
                視聴履歴はありません。<br />曲を再生すると自動的に記録されます。
              </p>
            </div>
          ) : (
            <ul>
              {entries.map((entry, i) => {
                const { song, playedAt } = entry;
                const thumb = getThumbUrl(song);
                const producer = getProducerString(song);

                return (
                  <li key={`${song.id}-${i}`}>
                    <button
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/5"
                      onClick={() => {
                        playSong(song, true);
                        toggleHistoryDrawer();
                      }}
                    >
                      {/* サムネイル */}
                      <div
                        className="flex-shrink-0 w-12 h-9 rounded overflow-hidden"
                        style={{ background: 'var(--color-surface-elevated)' }}
                      >
                        {thumb ? (
                          <img
                            src={thumb}
                            alt={song.name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
                                 style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>
                              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                            </svg>
                          </div>
                        )}
                      </div>

                      {/* テキスト情報 */}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate leading-tight"
                           style={{ color: 'var(--color-text-primary)' }}>
                          {song.name}
                        </p>
                        {producer && (
                          <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                            {producer}
                          </p>
                        )}
                      </div>

                      {/* ミニ星評価 */}
                      <div className="flex-shrink-0">
                        <StarRating
                          rating={getRating(song.id)}
                          onRate={(r) => {
                            setRating(song.id, r);
                          }}
                          size="sm"
                        />
                      </div>

                      {/* 相対時刻 */}
                      <div className="flex-shrink-0 text-[10px] whitespace-nowrap"
                           style={{ color: 'var(--color-text-muted)' }}>
                        {getRelativeTime(playedAt)}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
