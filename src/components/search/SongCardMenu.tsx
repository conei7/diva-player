import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { MouseEvent, RefObject } from 'react';
import { getMenuNextIndex } from '../../utils/menuNavigation';

export interface SongCardMenuPosition {
  top: number;
  right: number;
}

interface SongCardMenuProps {
  songName: string;
  menuOpen: boolean;
  menuPos: SongCardMenuPosition | null;
  menuRef: RefObject<HTMLDivElement | null>;
  menuPortalRef: RefObject<HTMLDivElement | null>;
  buttonRef: RefObject<HTMLButtonElement | null>;
  isWatchLater: boolean;
  hasPlayablePV: boolean;
  onAddToQueue?: (event: MouseEvent<HTMLButtonElement>) => void;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  onWatchLater: (event: MouseEvent<HTMLButtonElement>) => void;
  onSaveToPlaylist: (event: MouseEvent<HTMLButtonElement>) => void;
  onShare: (event: MouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
}

const menuItemClass = 'w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left';

export default function SongCardMenu({
  songName,
  menuOpen,
  menuPos,
  menuRef,
  menuPortalRef,
  buttonRef,
  isWatchLater,
  hasPlayablePV,
  onAddToQueue,
  onToggle,
  onWatchLater,
  onSaveToPlaylist,
  onShare,
  onClose,
}: SongCardMenuProps) {
  useEffect(() => {
    if (!menuOpen) return;
    menuPortalRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [menuOpen, menuPortalRef]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      buttonRef.current?.focus();
      return;
    }
    const items = Array.from(menuPortalRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const next = getMenuNextIndex(event.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="relative flex-shrink-0" ref={menuRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${songName} のメニュー`}
        className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-white/10"
        style={{ color: 'var(--color-text-muted)' }}
        onClick={onToggle}
        title="メニュー"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
        </svg>
      </button>

      {menuOpen && menuPos && createPortal(
        <div
          ref={menuPortalRef}
          role="menu"
          aria-label={`${songName} の操作メニュー`}
          onKeyDown={handleMenuKeyDown}
          className="fixed z-[200] rounded-xl overflow-hidden shadow-2xl min-w-[180px]"
          style={{ top: menuPos.top, right: menuPos.right, background: 'var(--color-bg-card)', border: '1px solid var(--color-border)' }}
        >
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            style={{ color: isWatchLater ? 'var(--color-accent-cyan)' : 'var(--color-text-primary)' }}
            onClick={(event) => { event.stopPropagation(); onWatchLater(event); onClose(); }}
          >
            <span aria-hidden="true">◷</span>
            {isWatchLater ? '後で聴くから削除' : '後で聴く'}
          </button>

          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            style={{ color: 'var(--color-text-primary)' }}
            onClick={(event) => { onSaveToPlaylist(event); onClose(); }}
          >
            <span aria-hidden="true">▣</span>
            再生リストに保存
          </button>

          {onAddToQueue && hasPlayablePV && (
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              style={{ color: 'var(--color-text-primary)' }}
              onClick={(event) => { onAddToQueue(event); onClose(); }}
            >
              <span aria-hidden="true">＋</span>
              キューに追加
            </button>
          )}

          <div className="border-t" style={{ borderColor: 'var(--color-border)' }} />

          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            style={{ color: 'var(--color-text-primary)' }}
            onClick={(event) => { onShare(event); onClose(); }}
            title="VocaDB URLをコピー"
          >
            <span aria-hidden="true">↗</span>
            共有
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
