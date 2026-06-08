import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Song } from '../../types/vocadb';
import ViewHistoryChart from './ViewHistoryChart';

/**
 * Description - 折りたたみ可能な概要欄
 */
interface DescriptionProps {
  song: Song;
}

const formatJapaneseViews = (views?: number): string => {
  if (views === undefined || views <= 0) return '-';
  if (views >= 100000000) {
    return (views / 100000000).toFixed(1).replace('.0', '') + '億';
  } else if (views >= 10000) {
    return (views / 10000).toFixed(1).replace('.0', '') + '万';
  } else {
    return views.toLocaleString();
  }
};

export default function Description({ song }: DescriptionProps) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();

  // PV情報を概要として使用
  const originalPV = song.pvs?.find(pv => pv.pvType === 'Original' && !pv.disabled);
  const description = originalPV?.description || '';

  // 投稿日
  const publishDate = song.publishDate
    ? new Date(song.publishDate).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
    : originalPV?.publishDate
    ? new Date(originalPV.publishDate).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  // PVサービスリスト
  const pvList = song.pvs?.filter(pv => !pv.disabled) || [];

  // アーティスト情報
  const producers = song.artists?.filter(a => a.categories?.includes('Producer')) || [];
  const vocalists = song.artists?.filter(a => a.categories === 'Vocalist') || [];
  const others = song.artists?.filter(a => !['Producer', 'Vocalist'].includes(a.categories)) || [];

  return (
    <div
      className="mt-3 rounded-xl p-3 cursor-pointer transition-colors"
      style={{ background: 'var(--color-surface)' }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* ヘッダー行 */}
      <div className="flex items-center gap-3 text-sm flex-wrap">
        {(pvList.some(p => p.service === 'Youtube') || (song.youtubeViews || 0) > 0) && (
          <span className="font-medium flex items-center gap-1" style={{ color: '#ef4444' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21.582 6.186a2.665 2.665 0 0 0-1.876-1.884C17.95 3.84 12 3.84 12 3.84s-5.95 0-7.706.462A2.665 2.665 0 0 0 2.418 6.186C2 7.952 2 12 2 12s0 4.048.418 5.814a2.665 2.665 0 0 0 1.876 1.884C6.05 20.16 12 20.16 12 20.16s5.95 0 7.706-.462a2.665 2.665 0 0 0 1.876-1.884C22 16.048 22 12 22 12s0-4.048-.418-5.814zM9.75 15.02v-6.04L15.05 12l-5.3 3.02z"/>
            </svg>
            {expanded ? (song.youtubeViews || 0).toLocaleString() : formatJapaneseViews(song.youtubeViews)}回
          </span>
        )}
        {(pvList.some(p => p.service === 'NicoNicoDouga') || (song.nicoViews || 0) > 0) && (
          <span className="font-medium flex items-center gap-1" style={{ color: '#3b82f6' }}>
            📺 {expanded ? (song.nicoViews || 0).toLocaleString() : formatJapaneseViews(song.nicoViews)}回
          </span>
        )}
        {song.favoritedTimes > 0 && (
          <span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>
            ♥ {song.favoritedTimes.toLocaleString()}
          </span>
        )}
        {publishDate && (
          <span style={{ color: 'var(--color-text-secondary)' }}>{publishDate}</span>
        )}
      </div>

      {/* 概要テキスト */}
      <div className={expanded ? '' : 'line-clamp-2'}>
        {description ? (
          <p className="text-sm mt-2 whitespace-pre-wrap" style={{ color: 'var(--color-text-primary)' }}>
            {description}
          </p>
        ) : (
          <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
            {song.artistString}
          </p>
        )}

        {/* 展開時の詳細情報 */}
        {expanded && (
          <div className="mt-4 space-y-3">
            {/* アーティスト詳細 */}
            {producers.length > 0 && (
              <div>
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>プロデューサー</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {producers.map(a => (
                    <button
                      key={a.id} 
                      className="text-sm px-2 py-0.5 rounded-full hover:brightness-125 transition-all" 
                      style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-primary)' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const artistName = a.name || a.artist?.name;
                        if (a.artist?.id) {
                          navigate(`/?artistId=${a.artist.id}&artistName=${encodeURIComponent(artistName || '')}`);
                        } else if (artistName) {
                          navigate(`/?q=${encodeURIComponent(artistName)}`);
                        }
                      }}
                    >
                      {a.name || a.artist?.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {vocalists.length > 0 && (
              <div>
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>ボーカル</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {vocalists.map(a => (
                    <button 
                      key={a.id} 
                      className="text-sm px-2 py-0.5 rounded-full hover:brightness-125 transition-all" 
                      style={{ background: 'rgba(6, 214, 160, 0.15)', color: 'var(--color-accent-cyan)' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const artistName = a.name || a.artist?.name;
                        if (a.artist?.id) {
                          navigate(`/?artistId=${a.artist.id}&artistName=${encodeURIComponent(artistName || '')}`);
                        } else if (artistName) {
                          navigate(`/?q=${encodeURIComponent(artistName)}`);
                        }
                      }}
                    >
                      {a.name || a.artist?.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {others.length > 0 && (
              <div>
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>その他参加</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {others.map(a => (
                    <span key={a.id} className="text-sm px-2 py-0.5 rounded-full" style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-secondary)' }}>
                      {a.name || a.artist?.name} ({a.categories})
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* PVリンク */}
            {pvList.length > 0 && (
              <div>
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>PVリンク</span>
                <div className="flex flex-col gap-1 mt-1">
                  {pvList.map(pv => (
                    <a
                      key={pv.id}
                      href={pv.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm flex items-center gap-2 hover:underline"
                      style={{ color: 'var(--color-accent-blue)' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                        style={(() => {
                          const isOriginal = pv.pvType === 'Original';
                          if (pv.service === 'Youtube') {
                            return {
                              background: isOriginal ? 'rgba(239,68,68,0.15)' : 'rgba(100,30,30,0.3)',
                              color: isOriginal ? '#ef4444' : '#b91c1c'
                            };
                          } else {
                            return {
                              background: isOriginal ? 'rgba(59,130,246,0.15)' : 'rgba(30,30,100,0.3)',
                              color: isOriginal ? '#3b82f6' : '#1e40af'
                            };
                          }
                        })()}
                      >
                        {pv.service === 'Youtube' ? 'YT' : 'ニコ'}
                      </span>
                      {pv.name || pv.url}
                      {pv.pvType !== 'Original' && (
                        <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>({pv.pvType})</span>
                      )}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 展開時の詳細情報（履歴チャート） */}
      {expanded && (
        <div className="mt-4 pt-4 border-t border-[rgba(255,255,255,0.05)]">
          <ViewHistoryChart songId={song.id} />
        </div>
      )}

      {/* 展開/折りたたみトグル */}
      <button
        className="text-xs font-medium mt-2"
        style={{ color: 'var(--color-text-secondary)' }}
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
      >
        {expanded ? '一部を表示' : 'もっと見る'}
      </button>
    </div>
  );
}
