import { compactRecommendationHint } from '../../utils/recommendationDisplayPreferences';

/**
 * Short labels for the recommendation reasons the shared table (COMPACT_HINTS) does not shorten.
 * A reason is a few words of gray text under the song (DESIGN_SPEC §7.5: 「音が近い」など); the full
 * sentence is only in the tooltip.
 */
const EXTRA_SHORT_REASONS: Readonly<Record<string, string>> = {
  '人気・話題性を加味した発見枠': '人気の曲',
  '人気・話題性から選んだおすすめ': '人気の曲',
  '最初に選んだ曲のベクトルに近いおすすめ': '最初の曲と音が近い',
  '最初に選んだ曲と音が近いおすすめ': '最初の曲と音が近い',
  '最初に選んだ曲と同じPを反映したおすすめ': '最初の曲と同じP',
};

/**
 * Full reasons whose wording still uses an internal term (「ベクトル」「発見枠」). They are shown in
 * the tooltip; the reranker's source texts can adopt these sentences later.
 */
const FULL_REASON_WORDING: Readonly<Record<string, string>> = {
  '最初に選んだ曲のベクトルに近いおすすめ': '最初に選んだ曲と音が近いおすすめ',
  '人気・話題性を加味した発見枠': '人気・話題性から選んだおすすめ',
};

/** The short label of a recommendation reason, as a source text for t(). */
export function shortRecommendationReason(reason: string): string {
  return EXTRA_SHORT_REASONS[reason] ?? compactRecommendationHint(reason);
}

/** The full reason for the tooltip, as a source text for t(). */
export function fullRecommendationReason(reason: string): string {
  return FULL_REASON_WORDING[reason] ?? reason;
}
