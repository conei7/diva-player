import { usePlayerStore } from '../../stores/playerStore';
import { useRatingStore } from '../../stores/ratingStore';
import { useUiStore } from '../../stores/uiStore';
import StarRating from './StarRating';
import type { Song } from '../../types/vocadb';
import { useQueueRecommendationStore } from '../../stores/queueRecommendationStore';

/** YoutubePVからサムネイルURLを生成 */
function getThumbUrl(song: Song): string | null {
  if (song.thumbUrl) return song.thumbUrl;
  const ytPv = song.pvs?.find(pv => pv.service === 'Youtube');
  if (ytPv) return `https://img.youtube.com/vi/${ytPv.pvId}/mqdefault.jpg`;
  return null;
}

/** アーティスト文字列からプロデューサー部分を抽出（ feat. 以前） */
function getProducerString(song: Song): string {
  const str = song.artistString ?? '';
  const featIdx = str.indexOf(' feat. ');
  return featIdx !== -1 ? str.slice(0, featIdx) : str;
}

export default function QueueDrawer() {
  const {
    queue, queueIndex,
    queueDrawerOpen, toggleQueueDrawer,
    jumpToIndex, removeDuplicateQueueSongs,
  } = usePlayerStore();
  const { getRating, setRating } = useRatingStore();
  const openSaveToPlaylist = useUiStore(s => s.openSaveToPlaylist);
  const recommendations = useQueueRecommendationStore(s => s.recommendations);
  const duplicateCount = queue.length - new Set(queue.map(song => song.id)).size;

  return (
    <>
      {/* オーバーレイ（ドロワー外クリックで閉じる） */}
      {queueDrawerOpen && (
        <div
          className="fixed inset-0 z-40"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={toggleQueueDrawer}
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
          transform: queueDrawerOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
          paddingBottom: 'var(--player-bar-height)',
          boxShadow: queueDrawerOpen ? '-8px 0 32px rgba(0,0,0,0.4)' : 'none',
        }}
        role="dialog"
        aria-label="再生キュー"
      >
        {/* ヘッダー */}
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
                 style={{ color: 'var(--color-accent-purple)' }}>
              <path d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/>
            </svg>
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
              再生キュー
            </span>
            {queue.length > 0 && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded-full"
                style={{
                  background: 'rgba(139, 92, 246, 0.15)',
                  color: 'var(--color-accent-purple)',
                }}
              >
                {queue.length}曲
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {duplicateCount > 0 && (
              <button
                className="btn-ghost p-1.5 rounded-lg"
                onClick={removeDuplicateQueueSongs}
                title={`Remove ${duplicateCount} duplicate songs`}
                style={{ color: '#fbbf24' }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18"/>
                  <path d="M8 6V4h8v2"/>
                  <path d="M6 6l1 14h10l1-14"/>
                  <path d="M10 11v5"/>
                  <path d="M14 11v5"/>
                </svg>
              </button>
            )}
            <button
              className="btn-ghost p-1.5 rounded-lg"
              onClick={() => openSaveToPlaylist(queue)}
              disabled={queue.length === 0}
              title="Save queue to playlist"
              style={{ color: queue.length > 0 ? 'var(--color-accent-cyan)' : 'var(--color-text-muted)' }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17 3H5a2 2 0 0 0-2 2v14l7-3 7 3V5a2 2 0 0 0-2-2zm-1 13.97-6-2.57-6 2.57V5h12v11.97zM19 7v14l-7-3-3.35 1.44 1.63-1.92L12 16.78l5 2.14V7h2z"/>
              </svg>
            </button>
            <button
              className="btn-ghost p-1.5 rounded-lg"
              onClick={toggleQueueDrawer}
              aria-label="閉じる"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
                   style={{ color: 'var(--color-text-muted)' }}>
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          </div>
        </div>

        {/* キューリスト */}
        <div className="flex-1 overflow-y-auto">
          {queue.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 px-4"
                 style={{ color: 'var(--color-text-muted)' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.3 }}>
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
              <p className="text-sm text-center">
                キューは空です。<br />曲を検索して再生してください。
              </p>
            </div>
          ) : (
            <ul>
              {queue.map((song, i) => {
                const isCurrent = i === queueIndex;
                const thumb = getThumbUrl(song);
                const producer = getProducerString(song);
                const recommendation = recommendations[String(song.id)];

                return (
                  <li key={`${song.id}-${i}`}>
                    <button
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
                      style={{
                        background: isCurrent
                          ? 'rgba(139, 92, 246, 0.12)'
                          : 'transparent',
                        borderLeft: isCurrent
                          ? '3px solid var(--color-accent-purple)'
                          : '3px solid transparent',
                      }}
                      onClick={() => jumpToIndex(i)}
                    >
                      {/* インデックス番号 or 再生中アイコン */}
                      <div
                        className="flex-shrink-0 w-5 text-center text-xs"
                        style={{ color: isCurrent ? 'var(--color-accent-purple)' : 'var(--color-text-muted)' }}
                      >
                        {isCurrent ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline' }}>
                            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                          </svg>
                        ) : (
                          i + 1
                        )}
                      </div>

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
                        <p
                          className="text-xs font-medium truncate leading-tight"
                          style={{
                            color: isCurrent
                              ? 'var(--color-accent-purple)'
                              : 'var(--color-text-primary)',
                          }}
                        >
                          {song.name}
                        </p>
                        {producer && (
                          <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                            {producer}
                          </p>
                        )}
                        {recommendation && (
                          <p className="text-[10px] truncate mt-0.5" style={{ color: 'var(--color-accent-cyan)' }} title={recommendation.reasonText}>
                            {recommendation.reasonText}
                          </p>
                        )}
                      </div>

                      {/* ミニ星評価 */}
                      <div className="flex-shrink-0">
                        <StarRating
                          rating={getRating(song.id)}
                          onRate={(r) => setRating(song.id, r)}
                          size="sm"
                        />
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
