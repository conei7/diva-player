import type { Song } from '../../types/vocadb';

/**
 * VideoInfo - 曲名、ボカロP名、再生回数などのメタデータ
 */
interface VideoInfoProps {
  song: Song;
}

export default function VideoInfo({ song }: VideoInfoProps) {
  // P名を抽出
  const producer = song.artists?.find(a => a.categories === 'Producer');
  const producerName = producer?.name || producer?.artist?.name || '';

  // ボーカリスト名を抽出
  const vocalists = song.artists
    ?.filter(a => a.categories === 'Vocalist')
    .map(a => a.name || a.artist?.name || '')
    .filter(Boolean) || [];

  // 投稿日
  const publishDate = song.publishDate
    ? new Date(song.publishDate).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  return (
    <div className="mt-3">
      {/* 曲名 */}
      <h1
        className="text-xl font-bold leading-tight"
        style={{ color: 'var(--color-text-primary)' }}
      >
        {song.name}
      </h1>

      {/* メタ情報行 */}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {/* P名 */}
        {producerName && (
          <span
            className="text-sm font-medium cursor-pointer hover:underline"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {producerName}
          </span>
        )}

        {/* ボーカリスト */}
        {vocalists.length > 0 && (
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            feat. {vocalists.join(', ')}
          </span>
        )}

        {/* 区切り */}
        {(song.favoritedTimes > 0 || publishDate) && (
          <span style={{ color: 'var(--color-text-muted)' }}>•</span>
        )}

        {/* お気に入り数 */}
        {song.favoritedTimes > 0 && (
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            ♥ {song.favoritedTimes.toLocaleString()} お気に入り
          </span>
        )}

        {/* 投稿日 */}
        {publishDate && (
          <>
            <span style={{ color: 'var(--color-text-muted)' }}>•</span>
            <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              {publishDate}
            </span>
          </>
        )}

        {/* 曲タイプバッジ */}
        {song.songType !== 'Original' && (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full"
            style={{ background: 'rgba(139, 92, 246, 0.15)', color: 'var(--color-accent-purple)' }}
          >
            {song.songType}
          </span>
        )}
      </div>
    </div>
  );
}
