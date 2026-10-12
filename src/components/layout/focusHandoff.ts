import { useCallback, useRef } from 'react';

/**
 * Keeps the keyboard focus on a control whose DOM node is replaced when deferred code arrives:
 * the placeholder ⋮ (a Suspense fallback) → the loaded menu's trigger, or back to the placeholder
 * when the code cannot be loaded. Put the returned ref on every version of the control. When the
 * focused version goes away, the next version to appear takes the focus, unless the focus has
 * moved somewhere else in the meantime.
 */
export function useFocusHandoff<T extends HTMLElement>(): (node: T | null) => void {
  const nodeRef = useRef<T | null>(null);
  const pendingRef = useRef(false);
  return useCallback((node: T | null) => {
    if (node) {
      nodeRef.current = node;
      const take = pendingRef.current;
      pendingRef.current = false;
      const active = document.activeElement;
      if (take && (!active || active === document.body)) node.focus({ preventScroll: true });
      return;
    }
    // React detaches a ref before it removes the node, so a focused node still has the focus here.
    const previous = nodeRef.current;
    nodeRef.current = null;
    if (previous && document.activeElement === previous) pendingRef.current = true;
  }, []);
}
