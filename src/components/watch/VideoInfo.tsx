import type { Song } from '../../types/vocadb';
import { Link } from 'react-router-dom';
import OriginalVersionLink from './OriginalVersionLink';
import AlbumPlaylistButton from '../playlist/AlbumPlaylistButton';
import FavoriteProducerButton from './FavoriteProducerButton';
import { getSongProducerEntries } from '../../utils/songArtists';


/**
 * VideoInfo - 曲名、ボカロP名、再生回数などのメタデータ
 */
interface VideoInfoProps {
  song: Song;
}

export default function VideoInfo({ song }: VideoInfoProps) {
  // P名を抽出
  const producers = getSongProducerEntries(song);

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
          {producers.length > 0 ? producers.map((producer, index) => (
            <span key={`${producer.id ?? producer.name}-${index}`} className="inline-flex items-center gap-1">
              {producer.href ? (
                <Link
                  to={producer.href}
                  className="text-sm font-medium hover:underline"
                  style={{ color: 'var(--color-text-primary)' }}
                  aria-label={`${producer.name} の曲を表示`}
                >
                  {producer.name}
                </Link>
              ) : (
                <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                  {producer.name}
                </span>
              )}
              {producer.id && (
                <FavoriteProducerButton
                  id={producer.id}
                  name={producer.name}
                  artistType={producer.artistType}
                />
              )}
            </span>
          )) : (
            <span className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
              {song.artistString}
            </span>
          )}

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
      <OriginalVersionLink song={song} />
      <AlbumPlaylistButton song={song} />
    </div>
  );
}
