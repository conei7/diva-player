import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent, MouseEventHandler, Ref } from 'react';

/**
 * A button is disabled while it is loading, so the browser drops its focus to <body>. When a click
 * on the focused button started the work, focus goes back to the button once loading ends (unless
 * it has moved somewhere else meanwhile), so keyboard and screen reader users do not have to start
 * again from the top of the page.
 *
 * Returns the ref (also forwarded to `forwardedRef`) and the click handler to put on the button.
 */
export function useRefocusAfterLoading(
  loading: boolean,
  forwardedRef: Ref<HTMLButtonElement> | undefined,
  onClick: MouseEventHandler<HTMLButtonElement> | undefined,
): { ref: (node: HTMLButtonElement | null) => void; onClick: MouseEventHandler<HTMLButtonElement> | undefined } {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Set when a click on the focused button may start its loading state.
  const armedRef = useRef(false);

  const ref = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  useEffect(() => {
    if (loading || !armedRef.current) return;
    armedRef.current = false;
    const button = buttonRef.current;
    const active = document.activeElement;
    if (!button || !button.isConnected || button.disabled) return;
    if (active && active !== document.body) return;
    button.focus({ preventScroll: true });
  }, [loading]);

  const handleClick = onClick
    ? (event: MouseEvent<HTMLButtonElement>) => {
      armedRef.current = document.activeElement === event.currentTarget;
      onClick(event);
    }
    : undefined;

  return { ref, onClick: handleClick };
}
