export const RECOMMENDATION_HINTS_KEY = 'diva-player-recommendation-hints';

export function readRecommendationHintsEnabled(
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): boolean {
  try {
    return storage?.getItem(RECOMMENDATION_HINTS_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeRecommendationHintsEnabled(
  enabled: boolean,
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): void {
  try {
    storage?.setItem(RECOMMENDATION_HINTS_KEY, enabled ? '1' : '0');
  } catch {
    // A disabled storage backend should not affect browsing or playback.
  }
}

const COMPACT_HINTS: Readonly<Record<string, string>> = {
  'お気に入りPの楽曲を優先したおすすめ': 'お気に入りP',
  '音響・タグ・アーティスト情報が重なるおすすめ': '音・タグ・Pが近い',
  '音響的に近いおすすめ': '音が近い',
  'タグ・アーティスト情報も近いおすすめ': 'タグ・Pが近い',
  '完走・評価・プレイリストを反映したおすすめ': '好みから',
  '長期・最近の好みに近い新規開拓曲': '新しい発見',
  'プレイリストにある、聴き慣れた曲': 'プレイリストから',
  '履歴・評価をもとにした既知のおすすめ': '好みから',
  '評価・保存した曲の特徴に近いおすすめ': '好みの特徴',
};

export function compactRecommendationHint(reason: string): string {
  return COMPACT_HINTS[reason] ?? reason;
}
