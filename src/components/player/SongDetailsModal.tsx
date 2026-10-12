import { useRef } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useRatingStore } from '../../stores/ratingStore';
import { useLanguageStore } from '../../stores/languageStore';
import { showToast } from '../../stores/toastStore';
import StarRating from './StarRating';
import OriginalVersionLink from '../watch/OriginalVersionLink';
import SongAlbums from '../playlist/SongAlbums';
import { isPlayablePV } from '../../utils/playablePV';
import {
  formatArtistLine,
  formatClockDuration,
  serviceLabel,
  songTypeLabel,
} from '../../utils/songMeta';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import Dialog from '../ui/Dialog';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Menu, { MenuDivider, MenuItem } from '../ui/Menu';
import SongThumbnail from '../ui/SongThumbnail';
import { CloseIcon, MoreVertIcon, OpenInNewIcon, PlayIcon, PlaylistAddIcon, QueueMusicIcon } from '../ui/icons';
import { formatCalendarDate } from '../watch/watchFormat';
import { videoSourceLabel, withVideoName } from '../watch/videoLabels';

const VOCADB_BASE = 'https://vocadb.net';

/** A video chip. max-w-full + the truncating span keep a long video name inside the dialog. */
const CHIP_LINK =
  'inline-flex h-10 max-w-full items-center rounded-chip bg-yt-tonal px-3 text-sm font-medium leading-5 text-yt-text no-underline transition-colors duration-150 hover:bg-yt-tonal-hover sm:h-8';

/**
 * 曲の詳細 (opened from the sound map). Thumbnail, title, producer and rating at the top,
 * then 再生 / キューに追加 / 保存 / ⋮, a two-column fact list, albums and the videos.
 * Rows without a value are left out. On phones the rating gets its own row under the thumbnail
 * (the 40px stars do not fit next to it).
 */
export default function SongDetailsModal() {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const detailSong = useUiStore(state => state.detailSong);
  const closeSongDetail = useUiStore(state => state.closeSongDetail);
  const openSaveToPlaylist = useUiStore(state => state.openSaveToPlaylist);
  const setQueue = usePlayerStore(state => state.setQueue);
  const addToQueue = usePlayerStore(state => state.addToQueue);
  const rating = useRatingStore(state => (detailSong ? state.ratings[String(detailSong.id)] ?? 0 : 0));
  const setRating = useRatingStore(state => state.setRating);
  const playRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);

  if (!detailSong) return null;
  const song = detailSong;

  const pvLinks = (song.pvs ?? []).filter(isPlayablePV);
  const canPlay = pvLinks.length > 0;
  const publishDate = formatCalendarDate(song.publishDate, language);
  /**
   * 「YouTube」/「ニコニコ（転載）」. Where it is shown, withVideoName() adds a short video name when the song
   * has two videos of the same service and kind: 「YouTube · {name}」/「YouTubeで開く · {name}」.
   */
  const pvLabel = (pv: (typeof pvLinks)[number]) => (pv.pvType === 'Original'
    ? serviceLabel(pv.service, language)
    : videoSourceLabel(pv, language, t));
  const ratingControl = <StarRating rating={rating} onRate={value => setRating(song.id, value)} />;

  const facts: { label: string; value: string }[] = [];
  facts.push({
    label: t('曲の種類'),
    value: song.isSelfCover ? t('セルフカバー') : songTypeLabel(song.songType, language),
  });
  if (publishDate) facts.push({ label: t('公開日'), value: publishDate });
  if (song.lengthSeconds > 0) facts.push({ label: t('長さ'), value: formatClockDuration(song.lengthSeconds) });
  if (song.chorusStartSeconds != null) {
    const end = song.chorusEndSeconds ?? song.chorusStartSeconds + 15;
    facts.push({
      label: t('サビ（推定）'),
      // 0:43〜0:58 / 0:43–0:58 (an en dash in English)
      value: `${formatClockDuration(song.chorusStartSeconds)}${language === 'ja' ? '〜' : '–'}${formatClockDuration(end)}`,
    });
  }

  const handlePlay = () => {
    setQueue([song], 0);
    closeSongDetail();
  };

  const handleQueue = () => {
    // With nothing playing, start the song (the mini player appears) instead of an invisible queue.
    if (usePlayerStore.getState().currentSong) addToQueue(song);
    else setQueue([song], 0);
    showToast(t('キューに追加しました'));
  };

  return (
    <Dialog
      open
      onClose={closeSongDetail}
      ariaLabel={t('{song}の詳細', { song: song.name })}
      size="md"
      mobile="sheet"
      hideClose
      initialFocusRef={canPlay ? playRef : closeRef}
    >
      <div className="flex gap-4">
        <IconButton
          ref={closeRef}
          label={t('閉じる')}
          icon={<CloseIcon />}
          onClick={closeSongDetail}
          className="order-last -mr-3 -mt-3 max-sm:-mt-1"
        />
        <SongThumbnail song={song} className="w-[160px] max-sm:w-[120px]" radius="sm" loading="eager" />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 line-clamp-2 break-words text-lg font-bold leading-[26px] text-yt-text">{song.name}</h2>
          <p className="m-0 mt-1 truncate text-sm leading-5 text-yt-text-secondary">{formatArtistLine(song, { withVocalists: true })}</p>
          {!isMobile && <div className="mt-1">{ratingControl}</div>}
        </div>
      </div>

      {/* -ml-2.5 lines the first star up with the thumbnail (the 40px button is wider than the 20px star). */}
      {isMobile && <div className="-ml-2.5 mt-2">{ratingControl}</div>}

      <div className={isMobile ? 'mt-2 flex flex-wrap items-center gap-2' : 'mt-4 flex flex-wrap items-center gap-2'}>
        <Button ref={playRef} variant="primary" icon={<PlayIcon />} disabled={!canPlay} onClick={handlePlay}>
          {t('再生')}
        </Button>
        <Button icon={<QueueMusicIcon />} disabled={!canPlay} onClick={handleQueue}>
          {t('キューに追加')}
        </Button>
        <Button icon={<PlaylistAddIcon />} aria-label={t('プレイリストに保存')} onClick={() => openSaveToPlaylist(song)}>
          {t('保存')}
        </Button>
        <Menu trigger={<IconButton label={t('その他の操作')} icon={<MoreVertIcon />} variant="tonal" className="size-9!" />} align="end">
          <MenuItem icon={<OpenInNewIcon />} href={`${VOCADB_BASE}/S/${song.id}`} external>
            {t('VocaDBで開く')}
          </MenuItem>
          {pvLinks.length > 0 && <MenuDivider />}
          {pvLinks.map(pv => (
            <MenuItem key={pv.id} icon={<OpenInNewIcon />} href={pv.url} external>
              {withVideoName(t('{service}で開く', { service: pvLabel(pv) }), pv, pvLinks, language)}
            </MenuItem>
          ))}
        </Menu>
      </div>

      <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm leading-5 sm:grid-cols-[auto_1fr_auto_1fr]">
        {facts.map(fact => (
          <div key={fact.label} className="contents">
            <dt className="text-yt-text-secondary">{fact.label}</dt>
            <dd className="m-0 min-w-0 tabular-nums text-yt-text">{fact.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-2 text-sm leading-5 text-yt-text-secondary empty:hidden">
        <OriginalVersionLink song={song} />
      </div>

      <div className="mt-5 empty:hidden">
        <SongAlbums key={song.id} songId={song.id} />
      </div>

      {pvLinks.length > 0 && (
        <section className="mt-5" aria-label={tk('pvLinks')}>
          <h3 className="m-0 text-base font-bold leading-[22px] text-yt-text">{tk('pvLinks')}</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {pvLinks.map(pv => (
              <a key={pv.id} href={pv.url} target="_blank" rel="noopener noreferrer" className={CHIP_LINK}>
                <span className="truncate">{withVideoName(pvLabel(pv), pv, pvLinks, language)}</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </Dialog>
  );
}
