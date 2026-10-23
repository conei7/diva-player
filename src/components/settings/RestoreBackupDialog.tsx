import { useEffect, useId, useRef, useState } from 'react';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import {
  executeFullBackupImport,
  FullBackupImportError,
  readCurrentBackupCounts,
} from '../../services/fullBackup';
import type {
  FullBackupCounts,
  FullBackupImportErrorCode,
  FullBackupPreview,
  FullBackupSection,
  FullBackupValidationIssue,
} from '../../services/fullBackup';
import { confirmDialog } from '../../stores/confirmStore';
import { useLanguageStore } from '../../stores/languageStore';
import type { AppLanguage } from '../../stores/languageStore';
import { showToast } from '../../stores/toastStore';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import { InlineNotice } from '../ui/InlineNotice';
import { ErrorIcon } from '../ui/icons';
import { SettingRow, SettingsSelect } from './settingsControls';
import { useRefocusAfterBusy } from './useRefocusAfterBusy';

interface RestoreBackupDialogProps {
  preview: FullBackupPreview;
  /** 今のデータの件数（データタブで読み込み済みならそれを使う。null の時はここで読む） */
  currentCounts: FullBackupCounts | null;
  onClose: () => void;
  onRestored: (after: FullBackupCounts) => void;
}

type RestoreMode = 'merge' | 'replace';
type RatingPriority = 'backup' | 'current';

/** 失敗の中身（表示する時に訳す）。code が null なのは想定外の例外。 */
interface RestoreFailure {
  code: FullBackupImportErrorCode | null;
  section?: FullBackupSection;
  recoveryComplete: boolean;
  /** 元に戻せなかったデータ（重複なし） */
  notRolledBack: FullBackupSection[];
}

function toRestoreFailure(error: unknown): RestoreFailure {
  if (!(error instanceof FullBackupImportError)) return { code: null, recoveryComplete: false, notRolledBack: [] };
  return {
    code: error.code,
    section: error.section,
    recoveryComplete: error.recoveryComplete,
    notRolledBack: [...new Set(error.rollbackFailures.map(failure => failure.section))],
  };
}

/** 2026/10/11 / Oct 11, 2026。読めない日付は null。 */
function formatBackupDate(value: string, language: AppLanguage): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat(
    language === 'en' ? 'en-US' : 'ja-JP',
    language === 'en'
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: '2-digit', day: '2-digit' },
  ).format(time);
}

const noop = () => {};

/** 復元を止める問題を先に出す。 */
const ISSUE_ORDER: Record<FullBackupValidationIssue['kind'], number> = {
  'invalid-items': 0,
  'manifest-mismatch': 1,
  'legacy-format': 2,
};

/**
 * 「バックアップから復元」（DESIGN_SPEC §6.8.2）。ファイルを選ぶと設定の上に重ねて開く。
 * 件数の比較・復元方法・評価の優先を選んで復元する。置き換えは確認してから。
 */
export default function RestoreBackupDialog({ preview, currentCounts, onClose, onRestored }: RestoreBackupDialogProps) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const ids = useId();
  const language = useLanguageStore(state => state.language);
  const locale = language === 'en' ? 'en-US' : 'ja-JP';
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [ratingPriority, setRatingPriority] = useState<RatingPriority>('backup');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RestoreFailure | null>(null);
  const [loadedCounts, setLoadedCounts] = useState<FullBackupCounts | null>(null);
  const current = currentCounts ?? loadedCounts;
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  // 失敗してダイアログが残る時は、押した［復元］へフォーカスを戻す（成功した時は閉じるので、データタブが戻す）
  useRefocusAfterBusy(restoreButtonRef, busy);

  useEffect(() => {
    if (currentCounts) return undefined;
    let cancelled = false;
    readCurrentBackupCounts()
      .then(next => { if (!cancelled) setLoadedCounts(next); })
      .catch(error => console.error('[FullBackup] Current count read failed', error));
    return () => { cancelled = true; };
  }, [currentCounts]);

  const date = formatBackupDate(preview.parsed.exportedAt, language);
  const title = date ? t('{date}のバックアップ', { date }) : t('バックアップから復元');
  const format = (value: number) => value.toLocaleString(locale);

  const rows: Array<{ key: keyof FullBackupCounts; label: string; value: number }> = [
    { key: 'historyEvents', label: t('履歴'), value: preview.historyCount },
    { key: 'ratingCount', label: t('評価'), value: preview.ratingCount },
    { key: 'playlistCount', label: t('プレイリスト'), value: preview.playlistCount },
    { key: 'playlistSongCount', label: t('登録曲'), value: preview.playlistSongCount },
    { key: 'folderCount', label: tk('settingsFolders'), value: preview.folderCount },
    { key: 'favoriteProducerCount', label: t('お気に入りP'), value: preview.favoriteProducerCount },
    { key: 'hiddenSongCount', label: t('表示しない曲'), value: preview.hiddenSongCount },
  ];

  const issueText = (issue: FullBackupValidationIssue): string => {
    switch (issue.kind) {
      case 'legacy-format':
        return t('古い形式のため件数を確認できません');
      case 'manifest-mismatch':
        return t('件数が一致しません（ファイルが壊れている可能性があります）');
      case 'invalid-items':
        return issue.count === 1
          ? t('このファイルは復元できません（無効な項目が1件あります）')
          : t('このファイルは復元できません（無効な項目が{count}件あります）', { count: format(issue.count) });
    }
  };

  /** 失敗の理由（どのデータで止まったか）。§2.1-7: 保存キー名や例外の原文は出さない（console にだけ出す） */
  const failureCauseText = (value: RestoreFailure): string | null => {
    switch (value.code) {
      case 'not-validated':
        return t('このファイルは復元できません');
      case 'read-failed':
        return value.section === 'history' ? t('今の再生履歴を読み取れませんでした') : t('今のデータを読み取れませんでした');
      case 'write-failed':
        switch (value.section) {
          case 'history': return t('再生履歴を保存できませんでした');
          case 'ratings': return t('評価を保存できませんでした');
          case 'playlists': return t('プレイリストとフォルダーを保存できませんでした');
          case 'hiddenSongs': return t('表示しない曲を保存できませんでした');
          case 'favoriteProducers': return t('お気に入りPを保存できませんでした');
          case 'globalFilters': return t('フィルターを保存できませんでした');
          case 'theme': return t('見た目を保存できませんでした');
          case 'language': return t('言語を保存できませんでした');
          default: return null;
        }
      default:
        return null;
    }
  };

  const notRolledBackText = (section: FullBackupSection): string => {
    switch (section) {
      case 'history': return t('再生履歴を元に戻せませんでした');
      case 'ratings': return t('評価を元に戻せませんでした');
      case 'playlists': return t('プレイリストとフォルダーを元に戻せませんでした');
      case 'hiddenSongs': return t('表示しない曲を元に戻せませんでした');
      case 'favoriteProducers': return t('お気に入りPを元に戻せませんでした');
      case 'globalFilters': return t('フィルターを元に戻せませんでした');
      case 'theme': return t('見た目を元に戻せませんでした');
      case 'language': return t('言語を元に戻せませんでした');
    }
  };

  /** 「詳細」の行: 止まった所 → 今のデータがどうなったか（元のままか、戻せなかったデータ） */
  const failureDetails = (value: RestoreFailure): string[] => {
    if (value.code === null) return [];
    const cause = failureCauseText(value);
    const outcome = value.recoveryComplete
      ? [t('今のデータは変更されていません')]
      : value.notRolledBack.map(notRolledBackText);
    return cause ? [cause, ...outcome] : outcome;
  };

  const restore = async () => {
    if (busy || !preview.canRestore) return;
    if (mode === 'replace') {
      const confirmed = await confirmDialog({
        title: t('今のデータを置き換えますか？'),
        message: t('履歴・評価・プレイリスト・表示しない曲・お気に入りP・フィルターがバックアップの内容になります')
          + (preview.parsed.sections.preferences?.theme ? ` ${t('見た目の設定も復元します')}` : '')
          + (preview.parsed.sections.preferences?.language ? ` ${t('言語設定も復元します')}` : ''),
        confirmLabel: t('置き換える'),
      });
      if (!confirmed) return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const result = await executeFullBackupImport(preview, { mode, ratingPriority });
      showToast(t('バックアップから復元しました'));
      onRestored(result.after);
    } catch (error) {
      console.error('[FullBackup] Restore failed', error);
      setFailure(toRestoreFailure(error));
      setBusy(false);
    }
  };

  const details = failure ? failureDetails(failure) : [];

  return (
    <Dialog
      open
      nested
      size="md"
      title={title}
      ariaLabel={t('バックアップから復元')}
      onClose={busy ? noop : onClose}
      closeOnBackdrop={!busy}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('キャンセル')}</Button>
          <Button ref={restoreButtonRef} variant="primary" loading={busy} disabled={!preview.canRestore} onClick={() => void restore()}>
            {mode === 'replace' ? t('置き換える') : t('復元')}
          </Button>
        </>
      )}
    >
      {preview.validationIssues.length > 0 && (
        <div className="flex flex-col gap-2 pb-2">
          {[...preview.validationIssues].sort((a, b) => ISSUE_ORDER[a.kind] - ISSUE_ORDER[b.kind]).map(issue => (
            <InlineNotice key={issue.kind} tone={issue.kind === 'legacy-format' ? 'warning' : 'error'}>
              {issueText(issue)}
            </InlineNotice>
          ))}
        </div>
      )}

      <table className="w-full border-collapse text-sm leading-5">
        <thead>
          <tr className="h-9 text-xs text-yt-text-secondary">
            <th scope="col" className="text-left font-medium">{t('項目')}</th>
            <th scope="col" className="w-28 text-right font-medium">{t('このファイル')}</th>
            <th scope="col" className="w-28 text-right font-medium">{t('現在')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key} className="h-9 border-t border-yt-divider">
              <th scope="row" className="text-left font-normal text-yt-text">{row.label}</th>
              <td className="text-right tabular-nums text-yt-text">{format(row.value)}</td>
              <td className="text-right tabular-nums text-yt-text-secondary">{current ? format(current[row.key]) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {preview.parsed.sections.preferences?.language && (
        <p className="mt-3 text-sm text-yt-text-secondary">{t('言語設定を含みます。置き換える場合のみ復元します')}</p>
      )}
      {preview.parsed.sections.preferences?.theme && (
        <p className="mt-3 text-sm text-yt-text-secondary">{t('見た目の設定を含みます。置き換える場合のみ復元します')}</p>
      )}
      <fieldset className="mt-5 border-t border-yt-divider pt-5" disabled={busy || !preview.canRestore}>
        <legend className="float-left w-full text-base font-bold leading-[22px] text-yt-text">{t('復元方法')}</legend>
        <div className="clear-both pt-1">
          {(['merge', 'replace'] as const).map(value => (
            <label key={value} className="flex min-h-14 cursor-pointer items-center gap-4 py-2 has-disabled:cursor-default">
              <input
                type="radio"
                name={`${ids}-mode`}
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                className="size-5 shrink-0 cursor-pointer accent-yt-link disabled:cursor-default"
              />
              <span className="min-w-0">
                <span className="block text-sm leading-5 text-yt-text">
                  {value === 'merge' ? t('追加する（おすすめ）') : t('置き換える')}
                </span>
                <span className="block text-xs leading-[18px] text-yt-text-secondary">
                  {value === 'merge' ? t('今のデータは残ります') : t('今のデータは削除されます')}
                </span>
              </span>
            </label>
          ))}
        </div>
        {mode === 'merge' && (
          <SettingRow label={t('評価が重なったとき')} htmlFor={`${ids}-ratings`}>
            <SettingsSelect
              id={`${ids}-ratings`}
              value={ratingPriority}
              onChange={event => setRatingPriority(event.target.value as RatingPriority)}
            >
              <option value="backup">{t('バックアップを優先')}</option>
              <option value="current">{t('今の評価を優先')}</option>
            </SettingsSelect>
          </SettingRow>
        )}
      </fieldset>

      {failure && (
        <div role="alert" className="mt-3">
          <p className="flex items-center gap-2 text-sm leading-5 text-yt-danger">
            <ErrorIcon size={20} />
            {t('復元できませんでした')}
          </p>
          {details.length > 0 && (
            <details className="mt-1 pl-7 text-xs leading-[18px] text-yt-text-secondary">
              <summary className="cursor-pointer select-none text-yt-text">{t('詳細')}</summary>
              <ul className="mt-1 list-disc pl-4 [overflow-wrap:anywhere]">
                {details.map(detail => <li key={detail}>{detail}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </Dialog>
  );
}
