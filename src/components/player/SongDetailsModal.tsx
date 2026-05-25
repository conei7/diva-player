import { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useRatingStore } from '../../stores/ratingStore';
import StarRating from './StarRating';

const VOCADB_BASE = 'https://vocadb.net';

/** 秒数を m:ss 形式に変換 */
function formatDuration(seconds: number): string {
  if (!seconds) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** 日付文字列を表示用にフォーマット */
function formatDate(dateStr?: string): string {
  if (!dateStr) return '不明';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** 曲タイプの日本語マッピング */
const SONG_TYPE_JA: Record<string, string> = {
  Original: 'オリジナル曲',
  Remaster: 'リマスター',
  Remix: 'リミックス',
  Cover: 'カバー',
  Arrangement: 'アレンジ',
  Instrumental: 'インストゥルメンタル',
  Mashup: 'マッシュアップ',
  MusicPV: 'ミュージックPV',
  DramaPV: 'ドラマPV',
  Other: 'その他',
  Unspecified: '未分類',
};

export default function SongDetailsModal() {
  const { detailSong, closeSongDetail } = useUiStore();
  const { setQueue } = usePlayerStore();
  const { getRating, setRating } = useRatingStore();

  // ESC キーで閉じる
  useEffect(() => {
    if (!detailSong) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSongDetail();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [detailSong, closeSongDetail]);

  // スクロール抑制
  useEffect(() => {
    if (detailSong) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [detailSong]);

  if (!detailSong) return null;

  const song = detailSong;

  // サムネイル取得
  const ytPv = song.pvs?.find(p => p.service === 'Youtube');
  const thumbUrl = song.thumbUrl
    ?? (ytPv ? `https://img.youtube.com/vi/${ytPv.pvId}/hqdefault.jpg` : null);

  // プロデューサー / ボーカリスト分類
  const producers  = song.artists?.filter(a => a.categories.includes('Producer'))  ?? [];
  const vocalists  = song.artists?.filter(a => a.categories.includes('Vocalist'))  ?? [];

  // PV一覧 (有効なもの)
  const pvLinks = (song.pvs ?? []).filter(pv => !pv.disabled && (pv.service === 'Youtube' || pv.service === 'NicoNicoDouga'));

  const handlePlay = () => {
    setQueue([song], 0);
    closeSongDetail();
  };

  return (
    <>
      {/* オーバーレイ */}
      <div
        className="fixed inset-0 z-[60]"
        style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
        onClick={closeSongDetail}
        aria-hidden="true"
      />

      {/* モーダル本体 */}
      <div
        className="fixed z-[61] inset-0 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label={`${song.name} の詳細`}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="relative w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            maxHeight: '90vh',
            overflowY: 'auto',
          }}
        >
          {/* 閉じるボタン */}
          <button
            className="absolute top-3 right-3 z-10 btn-ghost p-1.5 rounded-full"
            onClick={closeSongDetail}
            aria-label="閉じる"
            style={{
              background: 'rgba(0,0,0,0.4)',
              color: 'white',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>

          {/* サムネイル */}
          <div className="relative aspect-video w-full" style={{ background: 'var(--color-bg-secondary)' }}>
            {thumbUrl ? (
              <img src={thumbUrl} alt={song.name} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <svg className="w-16 h-16" style={{ color: 'var(--color-text-muted)' }} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                </svg>
              </div>
            )}
          </div>

          {/* コンテンツ */}
          <div className="p-5 flex flex-col gap-4">

            {/* タイトル + 評価 */}
            <div>
              <h2 className="text-lg font-bold leading-snug" style={{ color: 'var(--color-text-primary)' }}>
                {song.name}
              </h2>
              <div className="mt-2">
                <StarRating
                  rating={getRating(song.id)}
                  onRate={(r) => setRating(song.id, r)}
                  size="md"
                />
              </div>
            </div>

            {/* メタデータグリッド */}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              {producers.length > 0 && (
                <>
                  <dt style={{ color: 'var(--color-text-muted)' }}>プロデューサー</dt>
                  <dd style={{ color: 'var(--color-text-primary)' }}>
                    {producers.map(a => a.name).join(', ')}
                  </dd>
                </>
              )}
              {vocalists.length > 0 && (
                <>
                  <dt style={{ color: 'var(--color-text-muted)' }}>ボーカリスト</dt>
                  <dd style={{ color: 'var(--color-text-primary)' }}>
                    {vocalists.map(a => a.name).join(', ')}
                  </dd>
                </>
              )}
              {producers.length === 0 && vocalists.length === 0 && song.artistString && (
                <>
                  <dt style={{ color: 'var(--color-text-muted)' }}>アーティスト</dt>
                  <dd style={{ color: 'var(--color-text-primary)' }}>{song.artistString}</dd>
                </>
              )}
              <dt style={{ color: 'var(--color-text-muted)' }}>曲タイプ</dt>
              <dd style={{ color: 'var(--color-text-primary)' }}>
                {SONG_TYPE_JA[song.songType] ?? song.songType}
              </dd>
              {song.publishDate && (
                <>
                  <dt style={{ color: 'var(--color-text-muted)' }}>投稿日</dt>
                  <dd style={{ color: 'var(--color-text-primary)' }}>{formatDate(song.publishDate)}</dd>
                </>
              )}
              {song.lengthSeconds > 0 && (
                <>
                  <dt style={{ color: 'var(--color-text-muted)' }}>再生時間</dt>
                  <dd style={{ color: 'var(--color-text-primary)' }}>{formatDuration(song.lengthSeconds)}</dd>
                </>
              )}
              {song.ratingScore > 0 && (
                <>
                  <dt style={{ color: 'var(--color-text-muted)' }}>VocaDB評価</dt>
                  <dd style={{ color: 'var(--color-text-primary)' }}>
                    {song.ratingScore.toFixed(2)}&nbsp;
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      ({song.favoritedTimes.toLocaleString()} お気に入り)
                    </span>
                  </dd>
                </>
              )}
            </dl>

            {/* PVリンク */}
            {pvLinks.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {pvLinks.map(pv => (
                  <a
                    key={pv.id}
                    href={pv.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                    style={(() => {
                      const isOriginal = pv.pvType === 'Original';
                      if (pv.service === 'Youtube') {
                        return {
                          background: isOriginal ? 'rgba(239, 68, 68, 0.15)' : 'rgba(100, 30, 30, 0.3)',
                          color: isOriginal ? '#ef4444' : '#b91c1c',
                          border: isOriginal ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(100, 30, 30, 0.4)'
                        };
                      } else {
                        return {
                          background: isOriginal ? 'rgba(59, 130, 246, 0.15)' : 'rgba(30, 30, 100, 0.3)',
                          color: isOriginal ? '#3b82f6' : '#1e40af',
                          border: isOriginal ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid rgba(30, 30, 100, 0.4)'
                        };
                      }
                    })()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {pv.service === 'Youtube' ? '▶ YouTube' : '▶ ニコニコ'}
                    {pv.pvType !== 'Original' && (
                      <span className="ml-1 opacity-70">(非公式)</span>
                    )}
                  </a>
                ))}
                <a
                  href={`${VOCADB_BASE}/S/${song.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{
                    background: 'rgba(139, 92, 246, 0.12)',
                    color: 'var(--color-accent-purple)',
                    border: '1px solid rgba(139, 92, 246, 0.25)',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  VocaDB で見る
                </a>
              </div>
            )}

            {/* 再生ボタン */}
            <button
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-90"
              style={{ background: 'var(--gradient-primary)', color: 'white' }}
              onClick={handlePlay}
            >
              ▶ この曲を再生
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
