import { useLayoutEffect } from 'react';

/**
 * Layout variables that fixed bars publish on <html> so the page can make room for them
 * (DESIGN_SPEC §3.6), e.g. `--selection-bar-height` (SelectionBar: <main> and the sticky rows
 * move down) or `--bottom-bar-clearance` (a bar fixed above the mini player / bottom navigation:
 * the toast stays above it).
 *
 * Several holders of one variable stack: the newest value wins, the previous one comes back when
 * it unmounts, and the property is removed when the last holder goes away.
 */
const holders = new Map<string, Array<{ value: string }>>();

function applyVariable(name: string): void {
  const top = holders.get(name)?.at(-1);
  const root = document.documentElement;
  if (top) root.style.setProperty(name, top.value);
  else root.style.removeProperty(name);
}

/** Sets `name` (a CSS custom property) to `value` on <html> while mounted. `null` sets nothing. */
export function useRootLayoutVariable(name: string, value: string | null | undefined): void {
  useLayoutEffect(() => {
    if (value === null || value === undefined || typeof document === 'undefined') return undefined;
    const holder = { value };
    const stack = holders.get(name) ?? [];
    stack.push(holder);
    holders.set(name, stack);
    applyVariable(name);
    return () => {
      const current = holders.get(name);
      if (!current) return;
      const index = current.indexOf(holder);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) holders.delete(name);
      applyVariable(name);
    };
  }, [name, value]);
}
