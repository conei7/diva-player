/**
 * PlaylistToast – 統一トースト通知コンポーネント
 *
 * 画面下部中央に1つずつ表示し、自動で消滅。
 */
import { useEffect, useState } from 'react';
import type { ToastItem, ToastType } from '../../hooks/usePlaylistToast';

const TOAST_STYLES: Record<ToastType, { bg: string; color: string; border: string }> = {
  info: {
    bg: 'rgba(34,211,238,0.12)',
    color: 'var(--color-accent-cyan)',
    border: '1px solid rgba(34,211,238,0.28)',
  },
  success: {
    bg: 'rgba(34,197,94,0.14)',
    color: '#86efac',
    border: '1px solid rgba(34,197,94,0.3)',
  },
  warning: {
    bg: 'rgba(251,191,36,0.15)',
    color: '#fbbf24',
    border: '1px solid rgba(251,191,36,0.3)',
  },
};

export default function PlaylistToast({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map(toast => (
        <ToastMessage key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastMessage({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);
  const style = TOAST_STYLES[toast.type];

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  return (
    <div
      role="status"
      onClick={onDismiss}
      className="cursor-pointer rounded-xl px-4 py-2.5 text-sm shadow-lg transition-all duration-300"
      style={{
        background: style.bg,
        color: style.color,
        border: style.border,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
      }}
    >
      {toast.message}
      {toast.action && (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            toast.action?.onAction();
            onDismiss();
          }}
          className="ml-3 rounded-lg border border-current/40 px-2 py-1 text-xs font-semibold transition hover:bg-white/10"
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
