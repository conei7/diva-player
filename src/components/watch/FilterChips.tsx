/**
 * FilterChips - 推薦リスト上部のフィルタータブ
 *
 * 4つの丸薬型（Pill型）ボタン:
 * ① 「同じPの曲」 (RDB検索)
 * ② 「関連曲」 (Qdrant ハイブリッド検索)
 * ③ 「おすすめ」 (ユーザー履歴 + マルコフ連鎖)
 * ④ 「音響から探す」 (Qdrant 音響ベクトルのみ)
 */

export type RecTabKey = 'producer' | 'related' | 'recommended' | 'deep';

interface FilterChipsProps {
  activeTab: RecTabKey;
  onTabChange: (tab: RecTabKey) => void;
  counts?: Record<RecTabKey, number>;
}

const TABS: { key: RecTabKey; labelKey: 'filterRecommended' | 'filterRelated' | 'filterProducer' | 'filterSound'; descriptionKey: 'filterRecommendedDescription' | 'filterRelatedDescription' | 'filterProducerDescription' | 'filterSoundDescription' }[] = [
  { key: 'recommended', labelKey: 'filterRecommended', descriptionKey: 'filterRecommendedDescription' },
  { key: 'related', labelKey: 'filterRelated', descriptionKey: 'filterRelatedDescription' },
  { key: 'producer', labelKey: 'filterProducer', descriptionKey: 'filterProducerDescription' },
  { key: 'deep', labelKey: 'filterSound', descriptionKey: 'filterSoundDescription' },
];

export default function FilterChips({ activeTab, onTabChange, counts }: FilterChipsProps) {
  const t = useTranslate();
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
      <style>{`.filter-chips-scroll::-webkit-scrollbar { display: none; }`}</style>
      {TABS.map((tab) => {
        const isActive = tab.key === activeTab;
        const count = counts?.[tab.key];
        return (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className="yt-chip flex-shrink-0 transition-all"
            style={{
              background: isActive ? 'var(--color-yt-chip-active)' : 'var(--color-yt-chip)',
              color: isActive ? '#0f0f0f' : 'var(--color-yt-text)',
              fontWeight: isActive ? 600 : 400,
              fontSize: '13px',
              padding: '6px 14px',
            }}
            title={t(tab.descriptionKey)}
          >
            {t(tab.labelKey)}
            {count !== undefined && count > 0 && (
              <span
                className="ml-1 text-[10px] opacity-70"
                style={{ color: isActive ? '#0f0f0f' : 'var(--color-text-muted)' }}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
import { useTranslate } from '../../i18n';
