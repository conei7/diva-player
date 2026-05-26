import type { Song } from '../../types/vocadb';
import ViewHistoryChart from './ViewHistoryChart';

const formatJapaneseViews = (views?: number): string | null => {
  if (views === undefined || views <= 0) return null;
  if (views >= 100000000) {
    return (views / 100000000).toFixed(1).replace('.0', '') + '億';
  } else if (views >= 10000) {
    return (views / 10000).toFixed(1).replace('.0', '') + '万';
  } else {
    return views.toLocaleString();
  }
};

/**
 * VideoInfo - 曲名、ボカロP名、再生回数などのメタデータ
 */
interface VideoInfoProps {
  song: Song;
}

export default function VideoInfo({ song }: VideoInfoProps) {
  // P名を抽出
  const producer = song.artists?.find(a => a.categories?.includes('Producer'));
  const producerName = producer?.name || producer?.artist?.name || '';

  // ボーカリスト名を抽出
  const vocalists = song.artists
    ?.filter(a => a.categories === 'Vocalist')
    .map(a => a.name || a.artist?.name || '')
    .filter(Boolean) || [];

  return (
    <div className="mt-3">
      {/* 曲名 */}
      <h1
        className="text-xl font-bold leading-tight"
        style={{ color: 'var(--color-text-primary)' }}
      >
        {song.name}
      </h1>

      <div className="mt-2 flex flex-col gap-1">
        {/* ボーカリスト */}
        {vocalists.length > 0 && (
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            feat. {vocalists.join(', ')}
          </span>
        )}

        {/* 再生数等の統計 */}
        <div className="flex items-center flex-wrap gap-3 my-1">
          {song.youtubeViews !== undefined && song.youtubeViews > 0 && (
            <span className="text-sm font-semibold flex items-center gap-1" style={{ color: '#ef4444' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21.582 6.186a2.665 2.665 0 0 0-1.876-1.884C17.95 3.84 12 3.84 12 3.84s-5.95 0-7.706.462A2.665 2.665 0 0 0 2.418 6.186C2 7.952 2 12 2 12s0 4.048.418 5.814a2.665 2.665 0 0 0 1.876 1.884C6.05 20.16 12 20.16 12 20.16s5.95 0 7.706-.462a2.665 2.665 0 0 0 1.876-1.884C22 16.048 22 12 22 12s0-4.048-.418-5.814zM9.75 15.02v-6.04L15.05 12l-5.3 3.02z"/>
              </svg>
              {formatJapaneseViews(song.youtubeViews)} 回視聴
            </span>
          )}
          {song.nicoViews !== undefined && song.nicoViews > 0 && (
            <span className="text-sm font-semibold flex items-center gap-1" style={{ color: '#3b82f6' }}>
              📺 {formatJapaneseViews(song.nicoViews)} 回視聴
            </span>
          )}
          {song.favoritedTimes > 0 && (
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text-muted)' }}>
              ♥ {formatJapaneseViews(song.favoritedTimes)} お気に入り
            </span>
          )}
        </div>

        {/* 作者 */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="text-sm font-medium cursor-pointer hover:underline"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {producerName || song.artistString}
          </span>

          {/* 曲タイプバッジ */}
          {song.songType !== 'Original' && song.songType !== 'Unspecified' && (
            <span
              className="text-[10px] font-medium px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(139, 92, 246, 0.15)', color: 'var(--color-accent-purple)' }}
            >
              {song.songType}
            </span>
          )}
        </div>
      </div>
      
      {/* 履歴チャート */}
      <ViewHistoryChart songId={song.id} />
    </div>
  );
}
