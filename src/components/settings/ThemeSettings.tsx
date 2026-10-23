import { useId, useRef } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { useThemeStore } from '../../stores/themeStore';
import { showToast } from '../../stores/toastStore';
import { DEFAULT_ACCENT_COLOR } from '../../utils/theme';
import Button from '../ui/Button';
import { SettingRow, SettingsSelect } from './settingsControls';
import type { ThemeMode } from '../../utils/theme';

const PRESETS = [
  ['#06d6a0', 'ミント'], ['#ff8fc7', 'ピンク'], ['#be9bff', 'パープル'],
  ['#6dbbff', 'ブルー'], ['#ffba70', 'オレンジ'], ['#ff8585', 'レッド'],
] as const;

export default function ThemeSettings() {
  const t = useTranslateSourceText();
  const id = useId();
  const colorRef = useRef<HTMLInputElement>(null);
  const accentColor = useThemeStore(state => state.accentColor);
  const setAccentColor = useThemeStore(state => state.setAccentColor);
  const mode = useThemeStore(state => state.mode);
  const setMode = useThemeStore(state => state.setMode);
  const select = (color: string) => {
    if (!setAccentColor(color)) showToast(t('色は適用しましたが保存できませんでした'));
  };
  return (
    <section aria-label={t('見た目')} className="border-b border-yt-divider pb-3">
      <SettingRow label={t('テーマ')} htmlFor={`${id}-mode`}>
        <SettingsSelect id={`${id}-mode`} value={mode} onChange={event => {
          if (!setMode(event.target.value as ThemeMode)) showToast(t('テーマは適用しましたが保存できませんでした'));
        }}>
          <option value="system">{t('端末の設定に合わせる')}</option>
          <option value="dark">{t('ダーク')}</option>
          <option value="light">{t('ライト')}</option>
        </SettingsSelect>
      </SettingRow>
      <SettingRow label={t('アクセントカラー')} htmlFor={id} meta={t('再生中・進捗・オンの色')}>
        <input ref={colorRef} id={id} type="color" aria-label={t('カスタムカラー')} value={accentColor}
          onChange={event => select(event.target.value)}
          className="h-11 w-14 cursor-pointer rounded-chip border border-yt-outline bg-yt-tonal-solid p-1 focus-visible:outline-2 focus-visible:outline-yt-focus" />
      </SettingRow>
      <div role="group" aria-label={t('おすすめの色')} className="flex flex-wrap gap-2">
        {PRESETS.map(([color, name]) => (
          <button key={color} type="button" aria-label={t(name)} aria-pressed={accentColor === color}
            onClick={() => select(color)}
            className="flex size-11 items-center justify-center rounded-full border border-yt-outline focus-visible:outline-2 focus-visible:outline-yt-focus aria-pressed:border-yt-text aria-pressed:bg-yt-tonal">
            <span aria-hidden="true" className="size-6 rounded-full" style={{ backgroundColor: color }} />
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-yt-text-secondary">{t('テーマに合わせて色の明るさを調整します')}</p>
        <Button variant="text" disabled={accentColor === DEFAULT_ACCENT_COLOR}
          onClick={() => {
            colorRef.current?.focus({ preventScroll: true });
            select(DEFAULT_ACCENT_COLOR);
          }}>{t('初期色に戻す')}</Button>
      </div>
    </section>
  );
}
