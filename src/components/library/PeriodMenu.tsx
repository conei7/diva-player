import { useState } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import IconButton from '../ui/IconButton';
import Menu, { MenuDivider, MenuItem, MenuItemRadio } from '../ui/Menu';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import {
  currentYearMonth,
  formatReportRangeLabel,
  isFutureRange,
  isValidMonthKey,
  isValidYearKey,
  matchPreset,
  presetRange,
  shiftReportRange,
  type ReportPreset,
  type ReportRange,
} from './reportPeriod';

export interface PeriodMenuProps {
  range: ReportRange;
  onChange: (range: ReportRange) => void;
  now: number;
  timeZone: string;
  /** Phone layout: one full-width row. */
  fullWidth?: boolean;
}

type Picker = 'month' | 'year' | null;

const FIELD_CLASS =
  'h-10 w-full rounded-chip border border-yt-field-border bg-yt-field px-3 text-base leading-5 text-yt-text [color-scheme:dark] focus-visible:border-yt-focus focus-visible:outline-none sm:text-sm';

/** [‹] [2026年10月 ▾] [›] — the period of the report, with presets and month / year pickers. */
export default function PeriodMenu({ range, onChange, now, timeZone, fullWidth = false }: PeriodMenuProps) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const [picker, setPicker] = useState<Picker>(null);
  const [draft, setDraft] = useState('');

  const previous = shiftReportRange(range, -1);
  const nextRange = shiftReportRange(range, 1);
  const next = nextRange && !isFutureRange(nextRange, now, timeZone) ? nextRange : null;
  const preset = matchPreset(range, now, timeZone);
  const label = range.period === 'all' ? t('全期間') : formatReportRangeLabel(range, language);
  const { year, month } = currentYearMonth(now, timeZone);

  const presets: Array<{ preset: ReportPreset; label: string }> = [
    { preset: 'thisMonth', label: t('今月') },
    { preset: 'lastMonth', label: t('先月') },
    { preset: 'thisYear', label: t('今年') },
    { preset: 'lastYear', label: t('昨年') },
    { preset: 'all', label: t('全期間') },
  ];

  const openPicker = (kind: Exclude<Picker, null>) => {
    if (kind === 'month') {
      setDraft(range.period === 'month' ? range.key : `${year}-${String(month).padStart(2, '0')}`);
    } else {
      setDraft(range.period === 'year' ? range.key : String(year));
    }
    setPicker(kind);
  };

  const draftValid = picker !== null
    && (picker === 'month' ? isValidMonthKey(draft) : isValidYearKey(draft))
    && !isFutureRange({ period: picker, key: draft }, now, timeZone);
  const applyDraft = () => {
    if (!picker || !draftValid) return;
    onChange({ period: picker, key: draft });
    setPicker(null);
  };

  const pickerTitle = picker === 'month' ? t('月を選ぶ') : t('年を選ぶ');

  return (
    <>
      <div role="group" aria-label={t('期間')} className={cx('flex min-w-0 items-center gap-1', fullWidth && 'w-full')}>
        <IconButton
          label={t('前の期間')}
          icon={<ChevronLeftIcon />}
          disabled={!previous}
          onClick={() => previous && onChange(previous)}
        />
        <Menu
          trigger={(
            <Button
              variant="tonal"
              trailingIcon={<ChevronDownIcon />}
              className={cx('tabular-nums', fullWidth && 'min-w-0 flex-1')}
            >
              {label}
            </Button>
          )}
          label={t('期間')}
          align={fullWidth ? 'start' : 'end'}
        >
          {presets.map(item => (
            <MenuItemRadio
              key={item.preset}
              checked={preset === item.preset}
              onSelect={() => onChange(presetRange(item.preset, now, timeZone))}
            >
              {item.label}
            </MenuItemRadio>
          ))}
          <MenuDivider />
          <MenuItem onSelect={() => openPicker('month')}>{t('月を選ぶ…')}</MenuItem>
          <MenuItem onSelect={() => openPicker('year')}>{t('年を選ぶ…')}</MenuItem>
        </Menu>
        <IconButton
          label={t('次の期間')}
          icon={<ChevronRightIcon />}
          disabled={!next}
          onClick={() => next && onChange(next)}
        />
      </div>

      <Dialog
        open={picker !== null}
        onClose={() => setPicker(null)}
        title={pickerTitle}
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setPicker(null)}>{t('キャンセル')}</Button>
            <Button variant="primary" disabled={!draftValid} onClick={applyDraft}>{t('適用')}</Button>
          </>
        )}
      >
        <form
          onSubmit={event => {
            event.preventDefault();
            applyDraft();
          }}
        >
          {picker === 'month' ? (
            <input
              type="month"
              aria-label={pickerTitle}
              value={draft}
              min="2000-01"
              max={`${year}-${String(month).padStart(2, '0')}`}
              onChange={event => setDraft(event.target.value)}
              className={FIELD_CLASS}
            />
          ) : (
            <input
              type="number"
              inputMode="numeric"
              aria-label={pickerTitle}
              value={draft}
              min={2000}
              max={year}
              onChange={event => setDraft(event.target.value)}
              className={FIELD_CLASS}
            />
          )}
        </form>
      </Dialog>
    </>
  );
}
