/**
 * usePlaylistToast – プレイリスト用統一トースト通知フック
 */
import { useState, useCallback, useRef } from 'react';

export type ToastType = 'info' | 'success' | 'warning';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  action?: {
    label: string;
    onAction: () => void;
  };
}

const TOAST_DURATION = 4000;
const ACTION_TOAST_DURATION = 8000;

export function usePlaylistToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idCounter = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = 'info', action?: ToastItem['action']) => {
    const id = `toast-${++idCounter.current}`;
    setToasts(prev => [...prev, { id, message, type, action }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, action ? ACTION_TOAST_DURATION : TOAST_DURATION);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return { toasts, showToast, dismissToast };
}
