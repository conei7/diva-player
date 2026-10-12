import type { ReactNode, Ref, SelectHTMLAttributes } from 'react';
import { ChevronDownIcon } from '../ui/icons';
import { cx } from '../ui/overlay';

/** 区切り線＋16px の見出し＋行（設定ダイアログの本文の単位）。 */
export function SettingsSection({
  title,
  titleId,
  first = false,
  children,
}: {
  title: ReactNode;
  titleId: string;
  /** 先頭のセクションは区切り線を引かない */
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={titleId} className={cx(!first && 'mt-2 border-t border-yt-divider pt-5')}>
      <h3 id={titleId} className="text-base font-bold leading-[22px] text-yt-text">{title}</h3>
      <div className="mt-1">{children}</div>
    </section>
  );
}

/** ラベル（必要な時だけメタ1行）＋右端のコントロール。高さ 56px 以上。 */
export function SettingRow({
  label,
  labelId,
  htmlFor,
  meta,
  children,
}: {
  label: ReactNode;
  labelId?: string;
  /** コントロールの id（ラベルを押すとそこへフォーカス） */
  htmlFor?: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  // 狭い画面でコントロールが入りきらない時は、ラベルの下の行へ右寄せで回す
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 py-2">
      <div className="min-w-0 flex-[1_1_8rem]">
        <label id={labelId} htmlFor={htmlFor} className="block text-sm leading-5 text-yt-text">{label}</label>
        {meta && <p className="text-xs leading-[18px] text-yt-text-secondary">{meta}</p>}
      </div>
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

/** 36px・角丸 8px・#272727 の select（右に ▾）。 */
export function SettingsSelect({
  className,
  children,
  ref,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <span className={cx('relative inline-flex min-w-0 max-w-full', className)}>
      <select
        ref={ref}
        {...rest}
        className="h-9 min-w-0 max-w-[240px] cursor-pointer appearance-none truncate rounded-chip border-0 bg-yt-tonal-solid py-0 pl-3 pr-9 text-sm leading-5 text-yt-text transition-colors duration-150 hover:bg-yt-tonal-solid-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yt-focus disabled:cursor-default disabled:text-yt-text-disabled [&>option]:bg-yt-menu"
      >
        {children}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-yt-text-secondary">
        <ChevronDownIcon size={20} />
      </span>
    </span>
  );
}

/** 数値欄（3桁区切りで表示。数字以外は無視）。 */
export function SettingsNumberInput({
  value,
  onChange,
  label,
  locale,
  id,
}: {
  value: number;
  onChange: (value: number) => void;
  /** aria-label */
  label: string;
  locale: string;
  id?: string;
}) {
  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      value={value > 0 ? value.toLocaleString(locale) : ''}
      onChange={event => {
        const digits = event.target.value.replace(/\D/g, '').slice(0, 15);
        const next = digits ? Number(digits) : 0;
        onChange(Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER);
      }}
      className="h-9 w-[140px] rounded-chip border border-yt-field-border bg-yt-field px-3 text-right text-sm leading-5 tabular-nums text-yt-text outline-none transition-colors duration-150 placeholder:text-yt-text-disabled focus:border-yt-focus"
      placeholder="0"
    />
  );
}
