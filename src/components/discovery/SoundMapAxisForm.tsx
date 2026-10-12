import type { FormEvent } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { randomSoundMapAxes } from '../../utils/soundMapAxes';
import Button from '../ui/Button';
import { ShuffleIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { SwapIcon } from './discoveryIcons';

export interface SoundMapAxisFormProps {
  /** Zero-based feature indexes (shown as 1–1024). */
  axisX: number;
  axisY: number;
  disabled: boolean;
  onApply: (axes: [number, number]) => void;
  className?: string;
}

const INPUT_CLASS =
  'h-10 w-16 rounded-chip border border-yt-field-border bg-yt-field px-2 text-sm text-yt-text tabular-nums outline-none focus:border-yt-focus sm:h-8';

/** X / Y feature numbers with 「軸を適用」「軸をランダムに選ぶ」「XとYを入れ替え」 (the feature-axes e2e clicks them by name). */
export default function SoundMapAxisForm({ axisX, axisY, disabled, onApply, className }: SoundMapAxisFormProps) {
  const t = useTranslateSourceText();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const x = Number(data.get('axisX')) - 1;
    const y = Number(data.get('axisY')) - 1;
    const input = form.elements.namedItem('axisY') as HTMLInputElement;
    input.setCustomValidity(x === y ? t('XとYには異なる特徴を選んでください。') : '');
    if (form.reportValidity()) onApply([x, y]);
  };

  return (
    <form
      key={`${axisX}-${axisY}`}
      className={cx('flex flex-wrap items-center gap-2', className)}
      onInput={event => {
        (event.currentTarget.elements.namedItem('axisY') as HTMLInputElement).setCustomValidity('');
      }}
      onSubmit={submit}
    >
      <label className="flex items-center gap-1.5 text-sm font-medium leading-5 text-yt-text-secondary">
        X
        <input
          aria-label={t('Xの特徴番号')}
          className={INPUT_CLASS}
          type="number"
          name="axisX"
          min="1"
          max="1024"
          step="1"
          required
          defaultValue={axisX + 1}
        />
      </label>
      <label className="flex items-center gap-1.5 text-sm font-medium leading-5 text-yt-text-secondary">
        Y
        <input
          aria-label={t('Yの特徴番号')}
          className={INPUT_CLASS}
          type="number"
          name="axisY"
          min="1"
          max="1024"
          step="1"
          required
          defaultValue={axisY + 1}
          onInput={event => event.currentTarget.setCustomValidity('')}
        />
      </label>
      <Button type="submit" size="sm" disabled={disabled}>{t('軸を適用')}</Button>
      <Button size="sm" icon={<ShuffleIcon />} disabled={disabled} onClick={() => onApply(randomSoundMapAxes([axisX, axisY]))}>
        {t('軸をランダムに選ぶ')}
      </Button>
      <Button size="sm" icon={<SwapIcon />} disabled={disabled} onClick={() => onApply([axisY, axisX])}>
        {t('XとYを入れ替え')}
      </Button>
    </form>
  );
}
