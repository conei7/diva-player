import { useCallback, useRef } from 'react';
import { getSwipeDirection, type SwipeGesturePoint, type SwipeDirection } from '../utils/swipeGesture';

interface SwipeSurface {
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, [data-swipe-ignore]'));
}

export function usePlayerSwipeGesture({
  enabled,
  onSwipe,
}: {
  enabled: boolean;
  onSwipe: (direction: SwipeDirection) => void;
}) {
  const startRef = useRef<SwipeGesturePoint | null>(null);
  const activePointerRef = useRef<number | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!enabled || event.pointerType !== 'touch' || isInteractiveTarget(event.target)) return;
    activePointerRef.current = event.pointerId;
    startRef.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    try {
      (event.currentTarget as unknown as SwipeSurface).setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic events and older mobile browsers may not support capture.
    }
  }, [enabled]);

  const finish = useCallback((event: React.PointerEvent<HTMLElement>, cancelled = false) => {
    if (activePointerRef.current !== event.pointerId) return;
    const start = startRef.current;
    activePointerRef.current = null;
    startRef.current = null;
    try {
      (event.currentTarget as unknown as SwipeSurface).releasePointerCapture?.(event.pointerId);
    } catch {
      // The pointer may already have been released or cancelled.
    }
    if (cancelled || !start) return;
    const direction = getSwipeDirection(start, {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    });
    if (direction) onSwipe(direction);
  }, [onSwipe]);

  return {
    onPointerDown,
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => finish(event),
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => finish(event, true),
  };
}
