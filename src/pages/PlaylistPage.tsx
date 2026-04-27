import { useEffect, useState } from 'react';
import { usePlaylistStore } from '../stores/playlistStore';
import { usePlayerStore } from '../stores/playerStore';

/**
 * PlaylistPage - プレイリスト管理ページ
 * 
 * Phase 3 で完全実装予定。現時点では基本的なUI骨格を提供。
 */
export default function PlaylistPage() {
  const { playlists, loadPlaylists, createPlaylist, deletePlaylist } = usePlaylistStore();
  const { setQueue } = usePlayerStore();
  const [newName, setNewName] = useState('');

  useEffect(() => {
    loadPlaylists();
  }, [loadPlaylists]);

  const handleCreate = () => {
    if (!newName.trim()) return;
    createPlaylist(newName.trim());
    setNewName('');
  };

  const handlePlayAll = (playlistId: string) => {
    const playlist = playlists.find(p => p.id === playlistId);
    if (playlist && playlist.songs.length > 0) {
      setQueue(playlist.songs, 0);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-1 h-6 rounded-full" style={{ background: 'var(--gradient-accent)' }} />
        <h1 className="text-2xl font-bold">プレイリスト</h1>
      </div>

      {/* 新規作成 */}
      <div className="flex gap-3 max-w-md">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="新しいプレイリスト名..."
          className="search-input text-sm flex-1"
          style={{ paddingLeft: '1rem' }}
        />
        <button className="btn-primary text-sm" onClick={handleCreate}>
          作成
        </button>
      </div>

      {/* プレイリスト一覧 */}
      {playlists.length === 0 ? (
        <div className="text-center py-16 animate-fade-in">
          <svg className="w-16 h-16 mx-auto mb-4" style={{ color: 'var(--color-text-muted)' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 15V6" />
            <path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
            <path d="M12 12H3" />
            <path d="M16 6H3" />
            <path d="M12 18H3" />
          </svg>
          <p style={{ color: 'var(--color-text-muted)' }}>
            プレイリストがまだありません
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            上のフォームから新しいプレイリストを作成しましょう
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {playlists.map((playlist) => (
            <div
              key={playlist.id}
              className="rounded-xl p-4 transition-all duration-200 group"
              style={{
                background: 'var(--color-bg-card)',
                border: '1px solid var(--color-border)',
              }}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                    {playlist.name}
                  </h3>
                  <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                    {playlist.songs.length} 曲
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {playlist.songs.length > 0 && (
                    <button
                      className="btn-ghost p-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handlePlayAll(playlist.id)}
                      title="全曲再生"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-accent-cyan)' }}>
                        <path d="M8 5v14l11-7z"/>
                      </svg>
                    </button>
                  )}
                  <button
                    className="btn-ghost p-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => deletePlaylist(playlist.id)}
                    title="削除"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--color-error)' }}>
                      <path d="M3 6h18" />
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* 曲リスト（最大3曲プレビュー） */}
              {playlist.songs.length > 0 && (
                <div className="mt-3 space-y-1">
                  {playlist.songs.slice(0, 3).map((song, i) => (
                    <div key={song.id} className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                      <span style={{ color: 'var(--color-text-muted)' }}>{i + 1}.</span>
                      <span className="truncate">{song.name}</span>
                    </div>
                  ))}
                  {playlist.songs.length > 3 && (
                    <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      +{playlist.songs.length - 3} 曲
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
