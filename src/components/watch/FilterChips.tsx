/**
 * FilterChips - 推薦リスト上部のフィルタータブ
 *
 * 4つの丸薬型（Pill型）ボタン:
 * ① 「同じPの曲」 (RDB検索)
 * ② 「関連曲」 (Qdrant ハイブリッド検索)
 * ③ 「おすすめ」 (ユーザー履歴 + マルコフ連鎖)
 * ④ 「Deep Dig」 (Qdrant 音響ベクトルのみ)
 */

export type RecTabKey = 'producer' | 'related' | 'recommended' | 'deep';

interface FilterChipsProps {
  activeTab: RecTabKey;
  onTabChange: (tab: RecTabKey) => void;
  counts?: Record<RecTabKey, number>;
}

const TABS: { key: RecTabKey; label: string; description: string }[] = [
  { key: 'recommended', label: 'おすすめ',  description: 'AI推薦 (メタ+音響+履歴)' },
  { key: 'related',    label: '関連曲',    description: 'メタデータ類似' },
  { key: 'producer',   label: '同じPの曲', description: 'RDB検索' },
  { key: 'deep',       label: 'Deep Dig',  description: '音響類似' },
];

export default function FilterChips({ activeTab, onTabChange, counts }: FilterChipsProps) {
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
            title={tab.description}
          >
            {tab.label}
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
