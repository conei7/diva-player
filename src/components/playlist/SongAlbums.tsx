import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { AlbumSummary } from '../../types/vocadb';
import { getAlbumTracks, getAlbumsForSong } from '../../api/vocadb';
import { usePlaylistStore } from '../../stores/playlistStore';
import { usePlayerStore } from '../../stores/playerStore';
import { showToast } from '../../stores/toastStore';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { playlistPath } from '../../utils/routes';
import Button from '../ui/Button';
import { AlbumIcon } from '../ui/icons';

const COLLAPSED_ALBUM_COUNT = 2;

function AlbumCover({ album }: { album: AlbumSummary }) {
  const hiddenMode = usePlayerStore(state => state.hiddenMode);
  const [failed, setFailed] = useState<string | null>(null);
  const src = !hiddenMode && album.coverUrl && failed !== album.coverUrl ? album.coverUrl : null;
  return (
    <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-chip bg-yt-tonal text-yt-text-secondary">
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
          onError={() => setFailed(src)}
        />
      ) : (
        <AlbumIcon size={24} />
      )}
    </span>
  );
}

/**
 * アルバム (expanded description and the song details dialog): cover · name (VocaDB link) ·
 * 「プレイリストを作成」 (a new playlist with the album's tracks in album order).
 * Two albums at first, the rest behind 「すべて表示（{n}）」.
 * Mounted with the song ID as its key so requests and feedback stay with that song.
 */
export default function SongAlbums({ songId }: { songId: number }) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const navigate = useNavigate();
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const creating = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getAlbumsForSong(songId).then(result => {
      if (!cancelled) setAlbums(result);
    }).catch(() => {
      if (!cancelled) setLoadError(true);
    });
    return () => { cancelled = true; };
  }, [songId, loadAttempt]);

  const createFromAlbum = async (albumId: number) => {
    if (creating.current) return;
    creating.current = true;
    setBusyId(albumId);
    try {
      const { album, tracks } = await getAlbumTracks(albumId);
      const songs = tracks.map(track => track.song);
      if (songs.length === 0) throw new Error('empty album');
      const store = usePlaylistStore.getState();
      const usedNames = new Set(store.playlists.map(playlist => playlist.name));
      let name = album.name;
      let suffix = 2;
      while (usedNames.has(name)) name = `${album.name} (${suffix++})`;
      const playlist = store.createPlaylistWithSongs(name, songs, undefined, {
        coverArtUrl: album.coverUrl ?? songs[0]?.thumbUrl,
        description: album.releaseDate ? `VocaDB album / ${album.releaseDate}` : 'VocaDB album',
      });
      showToast(t('「{title}」を作成しました', { title: name }), {
        action: { label: t('開く'), onAction: () => navigate(playlistPath(playlist.id)) },
      });
    } catch {
      showToast(t('プレイリストを作成できませんでした'));
    } finally {
      creating.current = false;
      setBusyId(null);
    }
  };

  if (albums.length === 0 && !loadError) return null;

  const visibleAlbums = showAll || albums.length <= COLLAPSED_ALBUM_COUNT ? albums : albums.slice(0, COLLAPSED_ALBUM_COUNT);

  return (
    <section data-testid="song-albums" className="min-w-0" aria-label={tk('albumsLabel')}>
      <h3 className="text-base font-bold leading-[22px] text-yt-text">{tk('albumsLabel')}</h3>
      {albums.length > 0 && (
        <ul className="mt-2 space-y-2">
          {visibleAlbums.map(album => (
            <li key={album.id} className="flex min-w-0 items-center gap-3">
              <a
                href={`https://vocadb.net/Al/${album.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 flex-1 items-center gap-3 rounded-chip text-yt-text no-underline hover:underline"
                onClick={event => event.stopPropagation()}
              >
                <AlbumCover album={album} />
                <span className="min-w-0 break-words text-sm font-medium leading-5">{album.name}</span>
              </a>
              <Button
                size="sm"
                className="shrink-0"
                loading={busyId === album.id}
                disabled={busyId !== null}
                aria-label={t('「{album}」からプレイリストを作成', { album: album.name })}
                onClick={event => {
                  event.stopPropagation();
                  void createFromAlbum(album.id);
                }}
              >
                {t('プレイリストを作成')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {albums.length > COLLAPSED_ALBUM_COUNT && (
        <Button
          variant="text"
          size="sm"
          className="-ml-3 mt-1"
          aria-expanded={showAll}
          onClick={event => {
            event.stopPropagation();
            setShowAll(value => !value);
          }}
        >
          {showAll ? t('一部を表示') : t('すべて表示（{count}）', { count: albums.length })}
        </Button>
      )}
      {loadError && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm leading-5 text-yt-text-secondary">
          <span>{t('アルバムを読み込めませんでした')}</span>
          <Button
            variant="text"
            size="sm"
            onClick={event => {
              event.stopPropagation();
              setLoadError(false);
              setLoadAttempt(attempt => attempt + 1);
            }}
          >
            {t('再試行')}
          </Button>
        </div>
      )}
    </section>
  );
}
