import { useRef, useEffect } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { useRatingStore } from '../../stores/ratingStore';
import StarRating from './StarRating';
import type { Song } from '../../types/vocadb';

function getThumbUrl(song: Song): string | null {
  if (song.thumbUrl) return song.thumbUrl;
  const ytPv = song.pvs?.find(pv => pv.service === 'Youtube');
  if (ytPv) return `https://img.youtube.com/vi/${ytPv.pvId}/mqdefault.jpg`;
  return null;
}

function getProducerString(song: Song): string {
  const str = song.artistString ?? '';
  const featIdx = str.indexOf(' feat. ');
  return featIdx !== -1 ? str.slice(0, featIdx) : str;
}

export default function QueueSidebar() {
  const { queue, queueIndex, jumpToIndex } = usePlayerStore();
  const { getRating, setRating } = useRatingStore();
  const currentRef = useRef<HTMLLIElement>(null);

  // 現在の曲が変わったら自動スクロール
  useEffect(() => {
    currentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [queueIndex]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ヘッダー */}
      <div
        className="flex items-center gap-2 px-4 py-3 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
             style={{ color: 'var(--color-accent-purple)', flexShrink: 0 }}>
          <path d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/>
        </svg>
        <span className="text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          次の曲
        </span>
        {queue.length > 0 && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--color-accent-purple)' }}
          >
            {queue.length}曲
          </span>
        )}
      </div>

      {/* キューリスト */}
      <ul className="flex-1 overflow-y-auto">
        {queue.length === 0 ? (
          <li
            className="flex flex-col items-center justify-center h-32 gap-2 px-4 text-sm text-center"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.3 }}>
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
            キューが空です
          </li>
        ) : (
          queue.map((song, i) => {
            const isCurrent = i === queueIndex;
            const thumb = getThumbUrl(song);
            const producer = getProducerString(song);

            return (
              <li key={`${song.id}-${i}`} ref={isCurrent ? currentRef : null}>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/5"
                  style={{
                    background: isCurrent ? 'rgba(139,92,246,0.12)' : 'transparent',
                    borderLeft: isCurrent ? '3px solid var(--color-accent-purple)' : '3px solid transparent',
                  }}
                  onClick={() => jumpToIndex(i)}
                >
                  {/* インデックス or 再生中アイコン */}
                  <div
                    className="flex-shrink-0 w-4 text-center text-[10px] tabular-nums"
                    style={{ color: isCurrent ? 'var(--color-accent-purple)' : 'var(--color-text-muted)' }}
                  >
                    {isCurrent ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ display: 'inline' }}>
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                      </svg>
                    ) : (
                      i + 1
                    )}
                  </div>

                  {/* サムネイル */}
                  <div
                    className="flex-shrink-0 w-10 h-7 rounded overflow-hidden"
                    style={{ background: 'var(--color-surface-elevated)' }}
                  >
                    {thumb ? (
                      <img src={thumb} alt={song.name} className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"
                             style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>
                          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* テキスト情報 */}
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-[11px] font-medium truncate leading-tight"
                      style={{ color: isCurrent ? 'var(--color-accent-purple)' : 'var(--color-text-primary)' }}
                    >
                      {song.name}
                    </p>
                    {producer && (
                      <p className="text-[10px] truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                        {producer}
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
          })
        )}
      </ul>
    </div>
  );
}
