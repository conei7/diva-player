import type { Song } from '../../types/vocadb';
import { formatJapaneseViews } from '../../utils/formatViews';
import { getPVBadgeStyle, isUnofficialOnly } from '../../utils/pvBadge';
import { AUDIO_INSTRUMENT_LABELS } from '../../config/audioInstruments';

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
  const isSoundCloudUnofficialOnly = isUnofficialOnly(song.pvs ?? [], 'SoundCloud');
  const isBilibiliUnofficialOnly = isUnofficialOnly(song.pvs ?? [], 'Bilibili');

  return (
    <div className="flex items-center flex-wrap gap-2 mt-2">
      {(pvServices.has('Youtube') || (song.youtubeViews || 0) > 0) && (
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"
          style={{
            ...getPVBadgeStyle('Youtube', isYTUnofficialOnly ? 'Reprint' : 'Original'),
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
            ...getPVBadgeStyle('NicoNicoDouga', isNicoUnofficialOnly ? 'Reprint' : 'Original'),
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
          style={{
            ...getPVBadgeStyle('SoundCloud', isSoundCloudUnofficialOnly ? 'Reprint' : 'Original'),
            opacity: isSoundCloudUnofficialOnly ? 0.8 : 1,
          }}
          title="SoundCloudで再生可能"
        >
          SC
        </span>
      )}

      {pvServices.has('Bilibili') && (
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded"
          style={{
            ...getPVBadgeStyle('Bilibili', isBilibiliUnofficialOnly ? 'Reprint' : 'Original'),
            opacity: isBilibiliUnofficialOnly ? 0.8 : 1,
          }}
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

      {song.audioInstruments?.slice(0, 2).map(instrument => (
        <span key={instrument.key} className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-neutral-400" title={`音源解析による推定（信頼度 ${Math.round(instrument.score * 100)}%）`}>
          {AUDIO_INSTRUMENT_LABELS.get(instrument.key) ?? instrument.key}
        </span>
      ))}

      {song.isSelfCover && (
        <span className="rounded bg-fuchsia-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-200" title="原曲と同じプロデューサーによるカバー">
          Self Cover
        </span>
      )}

      <div className="flex-1" />

      {!song.isSelfCover && song.songType !== 'Original' && song.songType !== 'Unspecified' && (
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
