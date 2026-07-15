export type MenuNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/** Return the next menu item index, or null for keys that do not navigate. */
export function getMenuNextIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount <= 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  const direction = key === 'ArrowUp' ? -1 : 1;
  return (currentIndex + direction + itemCount) % itemCount;
}
