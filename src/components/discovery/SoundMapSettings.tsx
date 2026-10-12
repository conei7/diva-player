import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SoundMapPoint, SoundMapResponse } from '../../api/soundMap';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useTranslateSourceText } from '../../i18n';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import IconButton from '../ui/IconButton';
import InfoTip from '../ui/InfoTip';
import Popover from '../ui/Popover';
import { SettingsIcon } from '../ui/icons';

type Axes = NonNullable<SoundMapResponse['axes']>;
type FeatureKey = 'featureX' | 'featureY';

export interface SoundMapSettingsProps {
  axes: Axes;
  items: SoundMapPoint[];
  selected: SoundMapPoint | null;
  disabled: boolean;
  onSelect: (point: SoundMapPoint) => void;
  /** On phones the X / Y form lives here instead of above the map (gets a callback that closes the sheet). */
  renderAxisForm?: (close: () => void) => ReactNode;
}

function extreme(items: readonly SoundMapPoint[], key: FeatureKey, highest: boolean): SoundMapPoint | null {
  let best: SoundMapPoint | null = null;
  for (const point of items) {
    const value = point[key];
    if (value == null || !Number.isFinite(value)) continue;
    const bestValue = best?.[key];
    if (best === null || bestValue == null || (highest ? value > bestValue : value < bestValue)) best = point;
  }
  return best;
}

function formatValue(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '–';
}

/**
 * ⚙「表示設定」 for the feature-axes layout: what the axes are (ⓘ), their ranges, the songs at each
 * end and the selected song's raw values. A popover on desktop, a bottom sheet on phones.
 */
export default function SoundMapSettings({ axes, items, selected, disabled, onSelect, renderAxisForm }: SoundMapSettingsProps) {
  const t = useTranslateSourceText();
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  // In the sheet, focus the panel itself: focusing the X field would pop up the keyboard.
  const sheetStartRef = useRef<HTMLDivElement>(null);
  const pressInInfoRef = useRef(false);
  const infoLabel = t('特徴軸について');
  const close = () => setOpen(false);

  // The ⓘ popover is portaled to <body>, so for this popover a press in it is "outside" and would
  // close both. This capture listener on window runs before the popover's own one on document.
  useEffect(() => {
    if (!open || isMobile) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const layer = event.target instanceof Element ? event.target.closest('[role="dialog"]') : null;
      pressInInfoRef.current = layer?.getAttribute('aria-label') === infoLabel;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [infoLabel, isMobile, open]);

  const closePopover = () => {
    const pressedInInfo = pressInInfoRef.current;
    pressInInfoRef.current = false;
    if (!pressedInInfo) close();
  };

  const rows = [
    { axis: 'X', key: 'featureX' as const, index: axes.x, min: axes.minX, max: axes.maxX },
    { axis: 'Y', key: 'featureY' as const, index: axes.y, min: axes.minY, max: axes.maxY },
  ];

  const content = (
    <div className="flex flex-col gap-4 text-sm leading-5">
      <div className="flex h-5 items-center gap-1">
        <span className="font-medium text-yt-text">{t('特徴軸')}</span>
        <InfoTip label={infoLabel}>
          {t('名前のない音の特徴を2つ選んで並べます。候補は音全体の近さで選びます')}
        </InfoTip>
      </div>
      {renderAxisForm?.(close)}
      {rows.map(row => {
        const highest = extreme(items, row.key, true);
        const lowest = extreme(items, row.key, false);
        return (
          <div key={row.axis}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-yt-text">{row.axis === 'X' ? t('X · 特徴{n}', { n: row.index + 1 }) : t('Y · 特徴{n}', { n: row.index + 1 })}</span>
              <span className="text-xs text-yt-text-secondary tabular-nums">{formatValue(row.min, 3)} → {formatValue(row.max, 3)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" disabled={disabled || !highest} onClick={() => highest && onSelect(highest)}>
                {row.axis === 'X' ? t('Xが最大の曲') : t('Yが最大の曲')}
              </Button>
              <Button size="sm" disabled={disabled || !lowest} onClick={() => lowest && onSelect(lowest)}>
                {row.axis === 'X' ? t('Xが最小の曲') : t('Yが最小の曲')}
              </Button>
            </div>
          </div>
        );
      })}
      {selected && selected.featureX != null && selected.featureY != null && (
        <p className="m-0 text-xs text-yt-text-secondary tabular-nums">
          {t('選んだ曲: X {x} · Y {y}', { x: formatValue(selected.featureX, 5), y: formatValue(selected.featureY, 5) })}
        </p>
      )}
    </div>
  );

  return (
    <>
      <IconButton
        ref={anchorRef}
        label={t('表示設定')}
        icon={<SettingsIcon />}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      />
      {isMobile ? (
        <Dialog open={open} onClose={close} title={t('表示設定')} size="sm" mobile="sheet" initialFocusRef={sheetStartRef}>
          <div ref={sheetStartRef} tabIndex={-1} className="outline-none">{content}</div>
        </Dialog>
      ) : (
        <Popover anchor={anchorRef} open={open} onClose={closePopover} placement="bottom-end" width={320} label={t('表示設定')}>
          {content}
        </Popover>
      )}
    </>
  );
}
