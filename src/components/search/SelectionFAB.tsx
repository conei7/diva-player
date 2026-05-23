/**
 * SelectionFAB.tsx
 *
 * 複数選択モード中に画面下部に固定表示されるフローティングアクションバー。
 * ・モード終了ボタン (×)
 * ・選択数 / 全体数テキスト
 * ・全選択 / 全解除ボタン
 * ・アクションドロップダウン (⋮)
 * ・フィルター選択モーダル
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Song } from '../../types/vocadb';
import { useSelectionStore } from '../../stores/selectionStore';
import { usePlayerStore } from '../../stores/playerStore';
import { useUiStore } from '../../stores/uiStore';

// ─── フィルターモーダル ────────────────────────────────────────────────────────

type FilterTarget = 'title' | 'artist' | 'tag';

interface FilterModalProps {
  songs: Song[];
  onClose: () => void;
}

function FilterModal({ songs, onClose }: FilterModalProps) {
  const [target, setTarget] = useState<FilterTarget>('title');
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const selectAll = useSelectionStore(s => s.selectAll);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleApply = useCallback(() => {
    const q = caseSensitive ? query : query.toLowerCase();
    if (!q.trim()) { onClose(); return; }

    const matched = songs.filter(song => {
      let haystack = '';
      if (target === 'title') haystack = song.name;
      else if (target === 'artist') haystack = song.artistString ?? '';
      else if (target === 'tag') {
        haystack = (song.tags ?? []).map((t: { tag: { name: string } }) => t.tag.name).join(' ');
      }
      if (!caseSensitive) haystack = haystack.toLowerCase();
      return haystack.includes(q);
    });

    selectAll(matched);
    onClose();
  }, [query, caseSensitive, target, songs, selectAll, onClose]);

  const targetOptions: { value: FilterTarget; label: string }[] = [
    { value: 'title',  label: 'タイトル' },
    { value: 'artist', label: 'プロデューサー / アーティスト' },
    { value: 'tag',    label: 'タグ' },
  ];

  return (
    <div
      className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="w-full sm:w-[440px] rounded-t-2xl sm:rounded-2xl p-5 space-y-4"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-base" style={{ color: 'var(--color-text-primary)' }}>
            フィルターで選ぶ
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        {/* フィルター対象ラジオ */}
        <div className="space-y-2">
          <p className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>フィルター対象</p>
          <div className="flex flex-wrap gap-2">
            {targetOptions.map(opt => (
              <label
                key={opt.value}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full cursor-pointer text-sm transition-all"
                style={{
                  background: target === opt.value ? 'var(--gradient-primary)' : 'var(--color-bg-card)',
                  color: target === opt.value ? '#fff' : 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                }}
              >
                <input
                  type="radio"
                  className="sr-only"
                  checked={target === opt.value}
                  onChange={() => setTarget(opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {/* 検索文字列 */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>検索文字列</p>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleApply(); }}
            placeholder="キーワードを入力..."
            className="w-full px-3 py-2 rounded-xl text-sm outline-none transition-all"
            style={{
              background: 'var(--color-bg-card)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-primary)',
            }}
          />
        </div>

        {/* 大文字小文字区別 */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <div
            className="w-4 h-4 rounded flex items-center justify-center transition-all flex-shrink-0"
            style={{
              background: caseSensitive ? 'var(--color-primary)' : 'transparent',
              border: `2px solid ${caseSensitive ? 'var(--color-primary)' : 'var(--color-border)'}`,
            }}
            onClick={() => setCaseSensitive(v => !v)}
          >
            {caseSensitive && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="white">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            )}
          </div>
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            大文字と小文字を区別
          </span>
        </label>

        {/* 適用ボタン */}
        <button
          onClick={handleApply}
          className="w-full py-2.5 rounded-xl font-semibold text-sm text-white transition-opacity hover:opacity-90 active:opacity-80"
          style={{ background: 'var(--gradient-primary)' }}
        >
          適用 ({songs.filter(song => {
            const q = caseSensitive ? query : query.toLowerCase();
            if (!q.trim()) return true;
            let h = '';
            if (target === 'title') h = song.name;
            else if (target === 'artist') h = song.artistString ?? '';
            else h = (song.tags ?? []).map((t: { tag: { name: string } }) => t.tag.name).join(' ');
            if (!caseSensitive) h = h.toLowerCase();
            return h.includes(q);
          }).length} 件を選択)
        </button>
      </div>
    </div>
  );
}

// ─── メインFABコンポーネント ─────────────────────────────────────────────────

interface SelectionFABProps {
  /** 現在の画面に表示されている全曲（全選択/フィルター対象） */
  visibleSongs: Song[];
}

export default function SelectionFAB({ visibleSongs }: SelectionFABProps) {
  const {
    isSelectionMode,
    selectedSongIds,
    exitSelectionMode,
    selectAll,
    clearSelection,
  } = useSelectionStore();

  const { addToQueue, queue } = usePlayerStore();
  const { openSaveToPlaylist } = useUiStore();

  const [menuOpen, setMenuOpen] = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  // メニュー外クリックで閉じる
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // ESCで終了
  useEffect(() => {
    if (!isSelectionMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitSelectionMode();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isSelectionMode, exitSelectionMode]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // 選択されているSongオブジェクトを取得（visibleSongsから）
  const getSelectedSongs = useCallback((): Song[] => {
    return visibleSongs.filter(s => selectedSongIds.has(s.id));
  }, [visibleSongs, selectedSongIds]);

  const handleAddToQueue = useCallback(() => {
    const songs = getSelectedSongs();
    const existingIds = new Set(queue.map(s => s.id));
    let added = 0;
    songs.forEach(s => {
      if (!existingIds.has(s.id)) {
        addToQueue(s);
        added++;
      }
    });
    setMenuOpen(false);
    showToast(`${added} 曲をキューに追加しました`);
  }, [getSelectedSongs, addToQueue, queue, showToast]);

  const handleSaveToPlaylist = useCallback(() => {
    const songs = getSelectedSongs();
    if (songs.length === 0) return;
    setMenuOpen(false);
    openSaveToPlaylist(songs);
  }, [getSelectedSongs, openSaveToPlaylist]);

  const handleCopyIds = useCallback(() => {
    const ids = [...selectedSongIds].join(', ');
    navigator.clipboard.writeText(ids).catch(() => {});
    setMenuOpen(false);
    showToast('IDをコピーしました');
  }, [selectedSongIds, showToast]);

  const handleOpenFilterModal = useCallback(() => {
    setMenuOpen(false);
    setShowFilterModal(true);
  }, []);

  if (!isSelectionMode) return null;

  const selectedCount = selectedSongIds.size;
  const totalCount = visibleSongs.length;

  return (
    <>
      {/* FABバー */}
      <div
        className="fixed bottom-4 left-1/2 z-[250] flex items-center gap-1 px-4 py-2.5 rounded-full shadow-2xl"
        style={{
          transform: 'translateX(-50%)',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          backdropFilter: 'blur(12px)',
          animation: 'fab-slide-up 0.25s cubic-bezier(0.34,1.56,0.64,1) both',
          minWidth: 'min(90vw, 360px)',
          maxWidth: '90vw',
        }}
      >
        {/* × 終了ボタン */}
        <button
          onClick={exitSelectionMode}
          className="p-2 rounded-xl hover:bg-white/10 transition-colors flex-shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
          title="選択モード終了"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>

        {/* 選択数テキスト */}
        <span
          className="text-sm font-semibold flex-1 min-w-0 text-center"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {`${selectedCount.toLocaleString()} / ${totalCount.toLocaleString()} 選択済み`}
        </span>

        {/* 全選択 */}
        <button
          onClick={() => selectAll(visibleSongs)}
          className="p-2 rounded-xl hover:bg-white/10 transition-colors flex-shrink-0"
          style={{ color: 'var(--color-accent-cyan)' }}
          title="全て選択"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="3"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </button>

        {/* 全解除 */}
        <button
          onClick={clearSelection}
          className="p-2 rounded-xl hover:bg-white/10 transition-colors flex-shrink-0"
          style={{ color: selectedCount > 0 ? 'var(--color-text-muted)' : 'var(--color-text-disabled, var(--color-text-muted))' }}
          title="全て解除"
          disabled={selectedCount === 0}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="3"/>
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>

        {/* ⋮ アクションメニュー */}
        <div className="relative flex-shrink-0" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="p-2 rounded-xl hover:bg-white/10 transition-colors"
            style={{
              color: 'var(--color-text-primary)',
              background: menuOpen ? 'rgba(255,255,255,0.08)' : 'transparent',
            }}
            title="アクション"
            disabled={selectedCount === 0}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
            </svg>
          </button>

          {/* ドロップダウン */}
          {menuOpen && (
            <div
              className="absolute bottom-full mb-2 right-0 rounded-xl overflow-hidden shadow-2xl min-w-[200px] z-10"
              style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
            >
              {/* キューに追加 */}
              <button
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                style={{ color: 'var(--color-text-primary)' }}
                onClick={handleAddToQueue}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                  <path d="M3 18h13v-2H3v2zm0-5h10v-2H3v2zm0-7v2h13V6H3zm18 9.59L17.42 12 21 8.41 19.59 7l-5 5 5 5L21 15.59z"/>
                </svg>
                キューに追加
                <span className="ml-auto text-xs opacity-50">{selectedCount}</span>
              </button>

              {/* プレイリストに保存 */}
              <button
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                style={{ color: 'var(--color-text-primary)' }}
                onClick={handleSaveToPlaylist}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                  <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
                  <polyline points="17 21 17 13 7 13 7 21"/>
                  <polyline points="7 3 7 8 15 8"/>
                </svg>
                プレイリストに保存
                <span className="ml-auto text-xs opacity-50">{selectedCount}</span>
              </button>

              <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />

              {/* フィルターで選ぶ */}
              <button
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                style={{ color: 'var(--color-text-primary)' }}
                onClick={handleOpenFilterModal}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
                フィルターで選ぶ
              </button>

              {/* IDをコピー */}
              <button
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                style={{ color: 'var(--color-text-primary)' }}
                onClick={handleCopyIds}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
                選択曲のIDをコピー
              </button>
            </div>
          )}
        </div>
      </div>

      {/* フィルターモーダル */}
      {showFilterModal && (
        <FilterModal
          songs={visibleSongs}
          onClose={() => setShowFilterModal(false)}
        />
      )}

      {/* トースト通知 */}
      {toast && (
        <div
          className="fixed bottom-20 left-1/2 z-[260] px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg"
          style={{
            transform: 'translateX(-50%)',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-primary)',
            animation: 'fab-slide-up 0.2s ease both',
          }}
        >
          {toast}
        </div>
      )}

      {/* アニメーション定義 */}
      <style>{`
        @keyframes fab-slide-up {
          from { opacity: 0; transform: translateX(-50%) translateY(12px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </>
  );
}
