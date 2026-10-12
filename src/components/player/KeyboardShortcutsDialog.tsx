import { Fragment } from 'react';
import { useTranslateSourceText } from '../../i18n';
import Dialog from '../ui/Dialog';

interface ShortcutRow {
  keys: string[];
  label: string;
}

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-7 min-w-7 items-center justify-center rounded-badge bg-yt-tonal px-2 font-sans text-xs font-medium leading-4 text-yt-text">
      {children}
    </kbd>
  );
}

/** The list of keyboard shortcuts (DESIGN_SPEC §6.2.2). Opened with `?` or from the top bar's ⋮. */
export default function KeyboardShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslateSourceText();
  const rows: ShortcutRow[] = [
    { keys: ['/'], label: t('検索') },
    { keys: [t('スペース')], label: t('再生 / 一時停止') },
    { keys: ['←', '→'], label: t('5秒戻る / 進む') },
    { keys: ['Shift', '+', '←', '→'], label: t('前の曲 / 次の曲') },
    { keys: ['M'], label: t('ミュート') },
    { keys: ['F6'], label: t('通知の操作へ移動') },
    { keys: ['Ctrl', '+', 'Z'], label: t('元に戻す') },
    { keys: ['?'], label: t('この一覧') },
  ];

  return (
    <Dialog open={open} onClose={onClose} title={t('キーボード ショートカット')} size="sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-6 gap-y-3 pb-1">
        {rows.map(row => (
          <Fragment key={row.label}>
            <dt className="flex items-center gap-1">
              {row.keys.map((key, index) => (key === '+'
                ? <span key={index} aria-hidden="true" className="text-xs text-yt-text-secondary">+</span>
                : <KeyCap key={index}>{key}</KeyCap>))}
            </dt>
            <dd className="text-sm leading-5 text-yt-text">{row.label}</dd>
          </Fragment>
        ))}
      </dl>
    </Dialog>
  );
}
