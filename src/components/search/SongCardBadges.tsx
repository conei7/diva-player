import type { Song } from '../../types/vocadb';
import { formatJapaneseViews } from '../../utils/formatViews';

interface SongCardBadgesProps {
  song: Song;
  pvServices: Set<string>;
  isYTUnofficialOnly: boolean;
  isNicoUnofficialOnly: boolean;
  relativeDate?: string | null;
}

/** Presentation-only metadata row for a song card. */
export default function SongCardBadges({
  song,
  pvServices,
  isYTUnofficialOnly,
  isNicoUnofficialOnly,
  relativeDate,
}: SongCardBadgesProps) {
  return (
    <div className="flex items-center flex-wrap gap-2 mt-2">
      {(pvServices.has('Youtube') || (song.youtubeViews || 0) > 0) && (
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"
          style={{
            background: isYTUnofficialOnly ? 'rgba(100, 30, 30, 0.3)' : 'rgba(239, 68, 68, 0.12)',
            color: isYTUnofficialOnly ? '#b91c1c' : '#ef4444',
            opacity: isYTUnofficialOnly ? 0.8 : 1,
          }}
          title="YouTube 再生回数"
        >
          <span aria-hidden="true">▶</span>
          {song.youtubeViews && song.youtubeViews > 0
            ? formatJapaneseViews(song.youtubeViews)
            : (isYTUnofficialOnly ? '非公式YT' : 'YT')}
        </span>
      )}

      {(pvServices.has('NicoNicoDouga') || (song.nicoViews || 0) > 0) && (
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"
          style={{
            background: isNicoUnofficialOnly ? 'rgba(30, 30, 100, 0.3)' : 'rgba(59, 130, 246, 0.12)',
            color: isNicoUnofficialOnly ? '#1e40af' : '#3b82f6',
            opacity: isNicoUnofficialOnly ? 0.8 : 1,
          }}
          title="ニコニコ動画 再生回数"
        >
          <span aria-hidden="true">N</span>
          {song.nicoViews && song.nicoViews > 0
            ? formatJapaneseViews(song.nicoViews)
            : (isNicoUnofficialOnly ? '非公式ニコ' : 'ニコ')}
        </span>
      )}

      {pvServices.has('SoundCloud') && (
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(249, 115, 22, 0.14)', color: '#fb923c' }}
          title="SoundCloudで再生可能"
        >
          SC
        </span>
      )}

      {pvServices.has('Bilibili') && (
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(244, 114, 182, 0.14)', color: '#f472b6' }}
          title="Bilibiliで再生可能"
        >
          Bili
        </span>
      )}

      {relativeDate && (
        <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
          {relativeDate}
        </span>
      )}

      <div className="flex-1" />

      {song.songType !== 'Original' && song.songType !== 'Unspecified' && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-medium leading-none"
          style={{ background: 'rgba(139, 92, 246, 0.12)', color: 'var(--color-accent-purple)' }}
        >
          {song.songType}
        </span>
      )}
    </div>
  );
}
