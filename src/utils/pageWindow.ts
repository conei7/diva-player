/**
 * ページごとに開始位置をずらしつつ、同時取得対象を一定数へ制限する。
 * お気に入りPが増えてもホーム初期表示のAPI fan-outを固定できる。
 */
export function selectRotatingWindow<T>(items: readonly T[], page: number, size: number): T[] {
  if (items.length === 0 || size <= 0) return [];
  if (items.length <= size) return [...items];

  const start = (Math.max(0, page) * size) % items.length;
  return Array.from({ length: size }, (_, index) => items[(start + index) % items.length]);
}
