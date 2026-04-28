import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Song, PV } from '../../types/vocadb';
import { useSearchStore } from '../../stores/searchStore';
import { usePlayerStore } from '../../stores/playerStore';

interface SongDetailsPanelProps {
  song: Song | null;
  onClose: () => void;
  inline?: boolean;
}

function PVBadge({ pv }: { pv: PV }) {
  const isNico = pv.service === 'NicoNicoDouga';
  const label = isNico ? 'ニコ' : 'YT';
  const color = isNico ? '#3b82f6' : '#ef4444';
  const bg = isNico ? 'rgba(59,130,246,0.15)' : 'rgba(239,68,68,0.15)';
  const typeLabel = pv.pvType === 'Original' ? '公式' : pv.pvType === 'Reprint' ? '転載' : 'その他';
  const watchUrl = isNico
    ? `https://www.nicovideo.jp/watch/${pv.pvId}`
    : `https://www.youtube.com/watch?v=${pv.pvId}`;

  return (
    <a
      href={watchUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-3 py-2 rounded-lg transition-opacity hover:opacity-80"
      style={{ background: bg, textDecoration: 'none' }}
      onClick={(e) => e.stopPropagation()}
    >
      <span style={{ color, fontWeight: 700, fontSize: 12 }}>{label}</span>
      <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
        {pv.name || pv.pvId}
      </span>
      <span className="ml-auto" style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>{typeLabel}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" y1="14" x2="21" y2="3"/>
      </svg>
    </a>
  );
}

/**
 * SongDetailsPanel - 曲詳細スライドインパネル
 * 画面右側にスライドインして表示する。
 */
export default function SongDetailsPanel({ song, onClose, inline }: SongDetailsPanelProps) {
  const { searchByArtistId } = useSearchStore();
  const { currentSong, currentPV, setDetailPanelEl } = usePlayerStore();
  const isCurrentlyPlaying = currentSong?.id === song?.id && !!currentPV &&
    (currentPV.service === 'Youtube' || currentPV.service === 'NicoNicoDouga');
  const playerContainerRef = useRef<HTMLDivElement>(null);

  // プレイヤーコンテナをstoreに登録
  useEffect(() => {
    if (isCurrentlyPlaying && playerContainerRef.current) {
      setDetailPanelEl(playerContainerRef.current);
    }
    return () => {
      setDetailPanelEl(null);
    };
  }, [isCurrentlyPlaying, setDetailPanelEl]);
  // Esc キーで閉じる (overlay mode only)
  useEffect(() => {
    if (inline) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, inline]);

  if (!song) return null;

  const playablePVs = song.pvs?.filter(
    pv => !pv.disabled && (pv.service === 'Youtube' || pv.service === 'NicoNicoDouga'),
  ) ?? [];

  const producers = song.artists?.filter(a => a.categories === 'Producer') ?? [];
  const vocalists = song.artists?.filter(a => a.categories === 'Vocalist') ?? [];

  const vocadbUrl = `https://vocadb.net/S/${song.id}`;

  const formatDuration = (s: number) => {
    if (!s) return '--:--';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  const content = (
    <div className="p-4 flex flex-col gap-4">
      {/* サムネイル / 動画プレイヤー */}
      <div className="w-full rounded-lg overflow-hidden" style={{ aspectRatio: '16/9', background: 'var(--color-surface)' }}>
        {isCurrentlyPlaying ? (
          <div ref={playerContainerRef} className="w-full h-full" />
        ) : song?.thumbUrl ? (
          <img
            src={song.thumbUrl}
            alt={song.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <svg className="w-12 h-12" style={{ color: 'var(--color-text-muted)' }} viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
        )}
      </div>

      {/* タイトル / アーティスト */}
      <div>
        <h2 className="text-base font-bold leading-tight" style={{ color: 'var(--color-text-primary)' }}>
          {song.name}
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
          {song.artistString}
        </p>
      </div>

      {/* 基本情報 */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>曲タイプ</span>
          <p style={{ color: 'var(--color-text-primary)' }}>{song.songType}</p>
        </div>
        <div>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>時間</span>
          <p style={{ color: 'var(--color-text-primary)' }}>{formatDuration(song.lengthSeconds)}</p>
        </div>
        {song.publishDate && (
          <div>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>公開日</span>
            <p style={{ color: 'var(--color-text-primary)' }}>
              {new Date(song.publishDate).toLocaleDateString('ja-JP')}
            </p>
          </div>
        )}
        {song.favoritedTimes > 0 && (
          <div>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>お気に入り</span>
            <p style={{ color: 'var(--color-text-primary)' }}>{song.favoritedTimes.toLocaleString()}</p>
          </div>
        )}
      </div>

      {/* プロデューサー */}
      {producers.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            プロデューサー
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {producers.map(a => (
              <button key={a.id} className="text-xs px-2 py-1 rounded-full text-left transition-opacity hover:opacity-70"
                    style={{ background: 'var(--color-surface)', color: 'var(--color-text-secondary)' }}
                    onClick={() => { searchByArtistId(a.artist.id, a.name || a.artist.name); if (!inline) onClose(); }}>
                {a.name || a.artist.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ボーカリスト */}
      {vocalists.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            ボーカリスト
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {vocalists.map(a => (
              <button key={a.id} className="text-xs px-2 py-1 rounded-full text-left transition-opacity hover:opacity-70"
                    style={{
                      background: 'rgba(6, 214, 160, 0.1)',
                      color: 'var(--color-accent-green)',
                      border: '1px solid rgba(6, 214, 160, 0.2)',
                    }}
                    onClick={() => { searchByArtistId(a.artist.id, a.name || a.artist.name); if (!inline) onClose(); }}>
                {a.name || a.artist.name}
                {a.isSupport && <span style={{ opacity: 0.6 }}> (サポート)</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* PVリスト */}
      {playablePVs.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            動画 ({playablePVs.length}件)
          </h3>
          <div className="flex flex-col gap-1.5">
            {playablePVs.map(pv => <PVBadge key={pv.id} pv={pv} />)}
          </div>
        </div>
      )}
    </div>
  );

  // インラインモード: オーバーレイなしで埋め込み表示
  if (inline) {
    return (
      <div>
        {/* ヘッダー */}
        <div
          className="sticky top-0 flex items-center gap-3 px-4 py-3"
          style={{ background: 'var(--color-bg-secondary)', borderBottom: '1px solid var(--color-border)', zIndex: 1 }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            曲の詳細
          </span>
          <a
            href={vocadbUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
            style={{ color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', textDecoration: 'none' }}
          >
            VocaDB ↗
          </a>
        </div>
        {content}
      </div>
    );
  }

  const panel = createPortal(
    <>
      {/* オーバーレイ (クリックで閉じる) */}
      <div
        className="fixed inset-0"
        style={{ zIndex: 60, background: 'rgba(0,0,0,0.3)' }}
        onClick={onClose}
      />

      {/* パネル本体 */}
      <div
        className="fixed top-0 right-0 h-full overflow-y-auto animate-slide-in-right"
        style={{
          zIndex: 61,
          width: '380px',
          maxWidth: '90vw',
          background: 'var(--color-bg-secondary)',
          borderLeft: '1px solid var(--color-border)',
          paddingBottom: 'var(--player-bar-height)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div
          className="sticky top-0 flex items-center gap-3 px-4 py-3"
          style={{ background: 'var(--color-bg-secondary)', borderBottom: '1px solid var(--color-border)', zIndex: 1 }}
        >
          <button
            className="btn-ghost p-1.5 rounded-lg"
            onClick={onClose}
            title="閉じる"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
            曲の詳細
          </span>
          <a
            href={vocadbUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
            style={{ color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', textDecoration: 'none' }}
          >
            VocaDB ↗
          </a>
        </div>
        {content}
      </div>
    </>,
    document.body,
  );

  return panel;
}
