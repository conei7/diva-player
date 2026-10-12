import { describe, expect, it } from 'vitest';
import { englishSourceText } from '../../i18n-en';
import { fullRecommendationReason, shortRecommendationReason } from './reasonLabels';

// Every reason recommendationReranking's sourceReason() can give.
const RERANKING_REASONS = [
  '最初に選んだ曲と同じPを反映したおすすめ',
  '最初に選んだ曲のベクトルに近いおすすめ',
  'お気に入りPの楽曲を優先したおすすめ',
  '評価・保存した曲の特徴に近いおすすめ',
  '音響・タグ・アーティスト情報が重なるおすすめ',
  '音響的に近いおすすめ',
  'タグ・アーティスト情報も近いおすすめ',
  '完走・評価・プレイリストを反映したおすすめ',
  '人気・話題性を加味した発見枠',
];

describe('recommendation reason labels', () => {
  it('gives every reason a short label with an English translation', () => {
    for (const reason of RERANKING_REASONS) {
      const label = shortRecommendationReason(reason);
      expect(label.length, reason).toBeLessThan(reason.length);
      expect(englishSourceText[label], label).toBeTruthy();
    }
    expect(shortRecommendationReason('人気・話題性を加味した発見枠')).toBe('人気の曲');
    expect(shortRecommendationReason('音響的に近いおすすめ')).toBe('音が近い');
  });

  it('keeps internal terms out of the full reason and leaves other text alone', () => {
    for (const reason of RERANKING_REASONS) {
      const full = fullRecommendationReason(reason);
      expect(full).not.toMatch(/ベクトル|発見枠/u);
      if (full !== reason) expect(englishSourceText[full], full).toBeTruthy();
    }
    expect(shortRecommendationReason('1日平均 +104.9万回再生')).toBe('1日平均 +104.9万回再生');
    expect(fullRecommendationReason('1日平均 +104.9万回再生')).toBe('1日平均 +104.9万回再生');
  });
});
