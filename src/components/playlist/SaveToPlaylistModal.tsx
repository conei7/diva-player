/**
 * SaveToPlaylistModal
 * YouTube 風の「プレイリストに保存」ポップアップ。
 * uiStore.saveToPlaylistSong が非 null のときに表示される。
 * Portal 経由で body 直下にレンダリング。
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../stores/uiStore';
import { usePlaylistStore, WATCH_LATER_ID } from '../../stores/playlistStore';

export function SaveToPlaylistModal() {
  const song = useUiStore(s => s.saveToPlaylistSong);
  const close = useUiStore(s => s.closeSaveToPlaylist);
  const playlists = usePlaylistStore(s => s.playlists);
  const createPlaylist = usePlaylistStore(s => s.createPlaylist);
  const toggleSong = usePlaylistStore(s => s.toggleSongInPlaylist);
  const isSongIn = usePlaylistStore(s => s.isSongInPlaylist);
  const loadPlaylists = usePlaylistStore(s => s.loadPlaylists);

  const [newName, setNewName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // モーダルを開いたときにプレイリストをロード
  useEffect(() => {
    if (song) {
      loadPlaylists();
      setNewName('');
      setShowCreate(false);
    }
  }, [song, loadPlaylists]);

  // 新規プレイリスト作成フォームが開いたらフォーカス
  useEffect(() => {
    if (showCreate) inputRef.current?.focus();
  }, [showCreate]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === backdropRef.current) close(); },
    [close],
  );

  const handleCreate = useCallback(() => {
    const name = newName.trim();
    if (!name || !song) return;
    const pl = createPlaylist(name);
    toggleSong(pl.id, song);
    setNewName('');
    setShowCreate(false);
  }, [newName, song, createPlaylist, toggleSong]);

  if (!song) return null;

  // ソート: 後で聴く → その他
  const sorted = [...playlists].sort((a, b) => {
    if (a.id === WATCH_LATER_ID) return -1;
    if (b.id === WATCH_LATER_ID) return 1;
    return b.updatedAt - a.updatedAt;
  });

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
    >
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-80 max-h-[80vh] flex flex-col shadow-2xl">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-neutral-700">
          <h2 className="font-semibold text-sm text-white">プレイリストに保存</h2>
          <button
            onClick={close}
            className="text-neutral-400 hover:text-white transition-colors p-1 rounded"
          >
            ✕
          </button>
        </div>

        {/* 保存先の曲情報 */}
        <div className="flex items-center gap-2 px-4 py-2 bg-neutral-800">
          {song.thumbUrl && (
            <img src={song.thumbUrl} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
          )}
          <span className="text-xs text-neutral-300 truncate">{song.name}</span>
        </div>

        {/* プレイリスト一覧 */}
        <div className="overflow-y-auto flex-1 py-1">
          {sorted.map(pl => {
            const checked = isSongIn(pl.id, song.id);
            return (
              <label
                key={pl.id}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-800 cursor-pointer transition-colors"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSong(pl.id, song)}
                  className="accent-cyan-400 w-4 h-4 cursor-pointer flex-shrink-0"
                />
                {pl.id === WATCH_LATER_ID ? (
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded bg-neutral-700 flex items-center justify-center flex-shrink-0">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--color-accent-cyan)' }}>
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                      </svg>
                    </div>
                    <span className="text-sm text-white truncate">{pl.name}</span>
                    <span className="text-xs text-neutral-500 flex-shrink-0">{pl.songs.length}曲</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 min-w-0">
                    {pl.coverArtUrl ? (
                      <img src={pl.coverArtUrl} alt="" className="w-7 h-7 rounded object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-7 h-7 rounded bg-neutral-700 flex items-center justify-center flex-shrink-0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
                          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                        </svg>
                      </div>
                    )}
                    <span className="text-sm text-white truncate">{pl.name}</span>
                    <span className="text-xs text-neutral-500 flex-shrink-0">{pl.songs.length}曲</span>
                  </div>
                )}
              </label>
            );
          })}
        </div>

        {/* 新規プレイリスト作成 */}
        <div className="border-t border-neutral-700 px-4 py-2">
          {!showCreate ? (
            <button
              onClick={() => setShowCreate(true)}
              className="w-full text-left text-sm text-cyan-400 hover:text-cyan-300 transition-colors py-1.5 flex items-center gap-2"
            >
              <span className="text-lg leading-none">＋</span>
              新しいプレイリストを作成
            </button>
          ) : (
            <div className="flex gap-2 items-center">
              <input
                ref={inputRef}
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
                placeholder="プレイリスト名"
                className="flex-1 bg-neutral-800 border border-neutral-600 rounded px-2 py-1 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-cyan-500"
              />
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white px-3 py-1 rounded transition-colors"
              >
                作成
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
