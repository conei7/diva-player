import { useTranslate, useTranslateSourceText } from '../../i18n';
import { Chip, ChipBar } from '../ui/Chip';

/**
 * Chips above the related list: おすすめ / {P名}の曲 / 関連曲 / 曲調が近い
 * (multi-select is in the top bar).
 */
export type RecTabKey = 'producer' | 'related' | 'recommended' | 'deep';

interface FilterChipsProps {
  activeTab: RecTabKey;
  onTabChange: (tab: RecTabKey) => void;
  /** First producer of the song (「{producer}の曲」). Without it the chip says 「同じPの曲」. */
  producerName?: string;
  sticky?: boolean;
  className?: string;
}

const PRODUCER_NAME_MAX = 16;

function shortProducerName(name: string): string {
  return name.length > PRODUCER_NAME_MAX ? `${name.slice(0, PRODUCER_NAME_MAX - 1)}…` : name;
}

export default function FilterChips({ activeTab, onTabChange, producerName, sticky = false, className }: FilterChipsProps) {
  const tk = useTranslate();
  const t = useTranslateSourceText();

  const tabs: { key: RecTabKey; label: string }[] = [
    { key: 'recommended', label: tk('filterRecommended') },
    {
      key: 'producer',
      label: producerName ? t('{producer}の曲', { producer: shortProducerName(producerName) }) : tk('filterProducer'),
    },
    { key: 'related', label: tk('filterRelated') },
    { key: 'deep', label: t('曲調が近い') },
  ];

  return (
    <ChipBar
      label={t('関連曲の種類')}
      sticky={sticky}
      className={className}
    >
      {tabs.map(tab => (
        <Chip key={tab.key} selected={tab.key === activeTab} onClick={() => onTabChange(tab.key)}>
          {tab.label}
        </Chip>
      ))}
    </ChipBar>
  );
}
