import { useEffect, useRef, useState } from 'react';
import type { AlbumSummary } from '../../types/vocadb';
import { getAlbumTracks, getAlbumsForSong } from '../../api/vocadb';
import { usePlaylistStore } from '../../stores/playlistStore';
import { useTranslate } from '../../i18n';

/** Mounted with the song ID as its key so requests and feedback stay with that song. */
export default function SongAlbums({ songId }: { songId: number }) {
  const t = useTranslate();
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState('');
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
    setMessage(t('loadingAlbumTracks'));
    try {
      const { album, tracks } = await getAlbumTracks(albumId);
      const songs = tracks.map(track => track.song);
      if (songs.length === 0) throw new Error('empty album');
      const store = usePlaylistStore.getState();
      const usedNames = new Set(store.playlists.map(playlist => playlist.name));
      let name = album.name;
      let suffix = 2;
      while (usedNames.has(name)) name = `${album.name} (${suffix++})`;
      store.createPlaylistWithSongs(name, songs, undefined, {
        coverArtUrl: album.coverUrl ?? songs[0]?.thumbUrl,
        description: album.releaseDate ? `VocaDB album / ${album.releaseDate}` : 'VocaDB album',
      });
      setMessage(t('songsAddedToPlaylist', { count: songs.length, playlist: name }));
    } catch {
      setMessage(t('albumPlaylistError'));
    } finally {
      creating.current = false;
      setBusyId(null);
    }
  };

  if (albums.length === 0 && !loadError) return null;

  return (
    <section data-testid="song-albums" className="mt-3 space-y-2" aria-label={t('albumsLabel')}>
      <h3 className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>{t('albumsLabel')}</h3>
      {albums.map(album => (
        <div key={album.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <a href={`https://vocadb.net/Al/${album.id}`} target="_blank" rel="noopener noreferrer"
            className="min-w-0 break-words text-sm hover:underline" style={{ color: 'var(--color-accent-blue)' }}
            onClick={event => event.stopPropagation()}>{album.name}</a>
          <button type="button" className="btn-secondary min-h-10 shrink-0 px-3 py-1.5 text-xs"
            disabled={busyId !== null} aria-label={t('addAlbumToPlaylistAria', { album: album.name })}
            title={t('createAlbumPlaylistHint')}
            onClick={event => { event.stopPropagation(); void createFromAlbum(album.id); }}>
            {busyId === album.id ? t('loadingAlbumTracks') : t('addAlbumToPlaylist')}
          </button>
        </div>
      ))}
      {loadError && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs" role="status" style={{ color: 'var(--color-text-muted)' }}>{t('albumLoadError')}</p>
          <button type="button" className="btn-secondary min-h-10 px-3 text-xs" onClick={event => {
            event.stopPropagation(); setLoadError(false); setLoadAttempt(attempt => attempt + 1);
          }}>{t('retryAlbumLoad')}</button>
        </div>
      )}
      {message && <p className="text-xs" role="status" style={{ color: 'var(--color-text-muted)' }}>{message}</p>}
    </section>
  );
}
