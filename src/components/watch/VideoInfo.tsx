import { useState } from 'react';
import type { Song } from '../../types/vocadb';
import { Link } from 'react-router';
import FavoriteProducerButton from './FavoriteProducerButton';
import { getSongProducerEntries } from '../../utils/songArtists';


/**
 * VideoInfo - 曲名、ボカロP名、ボーカリストなどのメタデータ
 *
 * 洗練されたレイアウト: タイトル → P名(コンパクト) → feat. 歌手名
 * P名が多い場合は折りたたんで表示
 */
interface VideoInfoProps {
  song: Song;
}

const PRODUCER_COLLAPSE_THRESHOLD = 3;

export default function VideoInfo({ song }: VideoInfoProps) {
  const [showAllProducers, setShowAllProducers] = useState(false);

  // P名を抽出
  const producers = getSongProducerEntries(song);

  // ボーカリスト名を抽出
  const vocalists = song.artists
    ?.filter(a => a.categories === 'Vocalist')
    .map(a => a.name || a.artist?.name || '')
    .filter(Boolean) || [];

  const visibleProducers = showAllProducers || producers.length <= PRODUCER_COLLAPSE_THRESHOLD
    ? producers
    : producers.slice(0, PRODUCER_COLLAPSE_THRESHOLD);
  const hiddenCount = producers.length - visibleProducers.length;

  return (
    <div data-testid="watch-video-info" className="mt-3">
      {/* 曲名 */}
      <h1 className="text-xl font-bold leading-tight" style={{ color: 'var(--color-text-primary)' }}>
        {song.name}
      </h1>

      {/* アーティスト行: P名 + 曲タイプ + feat. ボーカリスト */}
      <div id="watch-producer-list" className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
        {/* プロデューサー */}
        {producers.length > 0 ? (
          <>
            {visibleProducers.map((producer, index) => (
              <span key={`${producer.id ?? producer.name}-${index}`} className="inline-flex items-center">
                {producer.href ? (
                  <Link
                    to={producer.href}
                    className="font-medium hover:underline"
                    style={{ color: 'var(--color-text-primary)' }}
                    aria-label={`${producer.name} の曲を表示`}
                  >
                    {producer.name}
                  </Link>
                ) : (
                  <span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>
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
                {index < visibleProducers.length - 1 && (
                  <span style={{ color: 'var(--color-text-muted)', margin: '0 2px' }}>,</span>
                )}
              </span>
            ))}
            {hiddenCount > 0 && (
              <button
                type="button"
                className="min-h-10 rounded px-2 text-xs transition-colors hover:bg-white/10 sm:min-h-7"
                style={{ color: 'var(--color-text-secondary)' }}
                onClick={() => setShowAllProducers(true)}
                aria-expanded="false"
                aria-controls="watch-producer-list"
                aria-label={`他${hiddenCount}名のPを表示`}
              >
                他{hiddenCount}名
              </button>
            )}
            {showAllProducers && producers.length > PRODUCER_COLLAPSE_THRESHOLD && (
              <button
                type="button"
                className="min-h-10 rounded px-2 text-xs transition-colors hover:bg-white/10 sm:min-h-7"
                style={{ color: 'var(--color-text-secondary)' }}
                onClick={() => setShowAllProducers(false)}
                aria-expanded="true"
                aria-controls="watch-producer-list"
                aria-label="P一覧を折りたたむ"
              >
                折りたたむ
              </button>
            )}
          </>
        ) : (
          <span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>
            {song.artistString}
          </span>
        )}

        {/* 曲タイプバッジ */}
        {song.songType !== 'Original' && song.songType !== 'Unspecified' && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{ background: 'rgba(139, 92, 246, 0.15)', color: 'var(--color-accent-purple)' }}
          >
            {song.songType}
          </span>
        )}

        {/* ボーカリスト */}
        {vocalists.length > 0 && (
          <span style={{ color: 'var(--color-text-secondary)' }}>
            feat. {vocalists.join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}
