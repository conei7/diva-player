import type { Song } from '../../types/vocadb';


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
    </div>
  );
}
