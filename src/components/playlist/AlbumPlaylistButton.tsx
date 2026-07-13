import { useState } from 'react';
import type { AlbumSummary, Song } from '../../types/vocadb';
import { getAlbumTracks, getAlbumsForSong } from '../../api/vocadb';
import { usePlaylistStore } from '../../stores/playlistStore';

export default function AlbumPlaylistButton({ song }: { song: Song }) {
  const createPlaylist = usePlaylistStore(state => state.createPlaylist);
  const updatePlaylist = usePlaylistStore(state => state.updatePlaylist);
  const addSongs = usePlaylistStore(state => state.addSongs);
  const playlists = usePlaylistStore(state => state.playlists);
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | ''>('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const loadAlbums = async () => {
    setBusy(true);
    setMessage('アルバムを取得中…');
    try {
      const result = await getAlbumsForSong(song.id);
      setAlbums(result);
      setSelectedId(result[0]?.id ?? '');
      setOpen(true);
      setMessage(result.length > 0 ? '' : 'この曲が登録されたアルバムはありません。');
    } catch {
      setMessage('アルバム情報を取得できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const createFromAlbum = async () => {
    if (!selectedId) return;
    setBusy(true);
    setMessage('トラックを取得中…');
    try {
      const { album, tracks } = await getAlbumTracks(Number(selectedId));
      const songs = tracks.map(track => track.song);
      if (songs.length === 0) throw new Error('empty album');
      const usedNames = new Set(playlists.map(playlist => playlist.name));
      let name = album.name;
      let suffix = 2;
      while (usedNames.has(name)) name = `${album.name} (${suffix++})`;
      const playlist = createPlaylist(name);
      updatePlaylist(playlist.id, { coverArtUrl: album.coverUrl, description: album.releaseDate ? `VocaDB album / ${album.releaseDate}` : 'VocaDB album' });
      addSongs(playlist.id, songs);
      setMessage(`${songs.length}曲を「${name}」へ追加しました。`);
      setOpen(false);
    } catch {
      setMessage('アルバムのプレイリスト化に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <button type="button" className="btn-secondary text-xs px-3 py-1.5" disabled={busy} onClick={() => void loadAlbums()}>アルバムをプレイリスト化</button>
      {open && albums.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select className="min-w-0 max-w-full rounded-lg px-2 py-1.5 text-xs bg-black/30 border border-white/10" value={selectedId} onChange={event => setSelectedId(event.target.value ? Number(event.target.value) : '')} disabled={busy}>
            {albums.map(album => <option key={album.id} value={album.id}>{album.name}</option>)}
          </select>
          <button type="button" className="btn-primary text-xs px-3 py-1.5" disabled={busy || selectedId === ''} onClick={() => void createFromAlbum()}>作成</button>
          <button type="button" className="btn-ghost text-xs px-2 py-1.5" disabled={busy} onClick={() => setOpen(false)}>取消</button>
        </div>
      )}
      {message && <p className="text-xs mt-1" role="status" style={{ color: 'var(--color-text-muted)' }}>{message}</p>}
    </div>
  );
}
